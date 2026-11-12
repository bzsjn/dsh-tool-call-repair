/**
 * dsh-tool-call-repair
 *
 * Two layers, both needed:
 *
 * 1. llm/stream  -- keep the chunk protocol intact. The adapter drops a
 *    tool-call block whose arguments JSON never finished and then raises
 *    MALFORMED_RESPONSE, leaving a block-start without a block-end. This layer
 *    closes every open block, so the turn ends as tool-calls/max-tokens
 *    instead of dying. A half-written argument string is passed through as
 *    text: the tool rejects it, the error goes back to the model, and the
 *    model retries on its own.
 *
 * 2. agent/request-error -- retry the request first, with exponential backoff
 *    and a bounded budget, because transient faults usually succeed on the
 *    second attempt.
 *
 * Neither layer rewrites truncated JSON: guessing the missing tail could
 * change the command that runs.
 */

export interface Config {
  /** Keep chunks paired and close a truncated stream instead of failing it. */
  repairStream?: boolean;
  /** Retries allowed per turn+step. `0` disables retrying. */
  maxRetries?: number;
  /** Retries allowed across one whole turn. */
  maxRetriesPerTurn?: number;
  /** Failure codes to retry. `['*']` means every code except the deny list. */
  codes?: string[];
  /** First backoff delay in milliseconds. */
  initialDelayMs?: number;
  /** Backoff ceiling in milliseconds. */
  maxDelayMs?: number;
  /** Backoff jitter ratio, `0` disables jitter. */
  jitterRatio?: number;
}

interface Logger {
  warn?: (message: string) => void;
}

interface Failure {
  code?: string;
  message?: string;
}

export interface RequestErrorPayload {
  agent?: object;
  turn?: number;
  step?: number;
  provider?: string;
  failure?: Failure;
  signal?: { aborted?: boolean; addEventListener?: Function; removeEventListener?: Function };
}

export type RequestErrorAction = { kind: 'retry' } | undefined;

/** One frame of the model stream. Only the fields this plugin reads are typed. */
export interface StreamChunk {
  type: string;
  index?: number;
  blockType?: string;
  text?: string;
  id?: string;
  name?: string;
  argumentsDelta?: string;
  block?: { type: string; [key: string]: unknown };
  reason?: { kind: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface PluginContext {
  logger?: Logger;
  on(event: 'agent/request-error', listener: (
    payload: RequestErrorPayload,
    next: () => Promise<RequestErrorAction>,
  ) => Promise<RequestErrorAction>): void;
  on(event: 'llm/stream', listener: (
    options: unknown,
    next: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>): void;
}

/** Codes where repeating the identical request cannot help. */
const NEVER_RETRY = new Set(['ABORTED', 'CONTEXT_WINDOW_EXCEEDED', 'INVALID_REPLAY_STATE', 'NO_ADAPTER']);

const DEFAULTS = {
  repairStream: true,
  maxRetries: 2,
  maxRetriesPerTurn: 5,
  codes: ['*'],
  initialDelayMs: 250,
  maxDelayMs: 4000,
  jitterRatio: 0.25,
};

interface ResolvedConfig {
  repairStream: boolean;
  maxRetries: number;
  maxRetriesPerTurn: number;
  anyCode: boolean;
  codes: Set<string>;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

interface StepBudget {
  turn: number | undefined;
  step: number | undefined;
  used: number;
}

interface TurnBudget {
  turn: number | undefined;
  used: number;
}

/** An open block being accumulated so it can be closed if the stream breaks. */
interface OpenBlock {
  type: string;
  text: string;
  args: string;
  id: string | undefined;
  name: string | undefined;
}

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalize(config?: Config): ResolvedConfig {
  const raw: Config = config ?? {};
  const codes = Array.isArray(raw.codes) ? raw.codes.map(String) : [...DEFAULTS.codes];
  return {
    repairStream: raw.repairStream !== false,
    maxRetries: Math.floor(positive(raw.maxRetries, DEFAULTS.maxRetries)),
    maxRetriesPerTurn: Math.floor(positive(raw.maxRetriesPerTurn, DEFAULTS.maxRetriesPerTurn)),
    anyCode: codes.includes('*'),
    codes: new Set(codes),
    initialDelayMs: positive(raw.initialDelayMs, DEFAULTS.initialDelayMs),
    maxDelayMs: positive(raw.maxDelayMs, DEFAULTS.maxDelayMs),
    jitterRatio: Math.min(1, positive(raw.jitterRatio, DEFAULTS.jitterRatio)),
  };
}

function eligible(options: ResolvedConfig, code: string): boolean {
  if (NEVER_RETRY.has(code)) return false;
  return options.anyCode || options.codes.has(code);
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Delay that resolves early when the turn is aborted. */
function backoffDelay(ms: number, signal?: RequestErrorPayload['signal']): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done);
  });
}

function openBlocks(open: Map<number, OpenBlock>): StreamChunk[] {
  const closing: StreamChunk[] = [];
  for (const [index, block] of open) {
    let content: { type: string; [key: string]: unknown };
    if (block.type === 'tool-call') {
      // Pass the raw (possibly truncated) argument text through: the tool
      // rejects it and the error reaches the model, which then retries.
      content = {
        type: 'tool-call',
        id: block.id ?? '',
        name: block.name ?? '',
        arguments: block.args.length > 0 ? block.args : '{}',
      };
    } else if (block.type === 'reasoning') {
      content = { type: 'reasoning', text: block.text };
    } else {
      content = { type: 'text', text: block.text };
    }
    closing.push({ type: 'block-end', index, block: content });
  }
  open.clear();
  return closing;
}

export const name = 'tool-call-repair';

export function apply(ctx: PluginContext, config?: Config): void {
  const options = normalize(config);
  const logger = ctx.logger;
  const steps = new WeakMap<object, StepBudget>();
  const turns = new WeakMap<object, TurnBudget>();

  if (options.repairStream) {
    ctx.on('llm/stream', (_options, next) => repair(next(), logger));
  }

  function takeBudget(agent: object, turn: number | undefined, step: number | undefined): number | undefined {
    let turnRecord = turns.get(agent);
    if (turnRecord === undefined || turnRecord.turn !== turn) {
      turnRecord = { turn, used: 0 };
      turns.set(agent, turnRecord);
    }
    if (turnRecord.used >= options.maxRetriesPerTurn) return undefined;

    let stepRecord = steps.get(agent);
    if (stepRecord === undefined || stepRecord.turn !== turn || stepRecord.step !== step) {
      stepRecord = { turn, step, used: 0 };
      steps.set(agent, stepRecord);
    }
    if (stepRecord.used >= options.maxRetries) return undefined;

    stepRecord.used += 1;
    turnRecord.used += 1;
    return stepRecord.used;
  }

  ctx.on('agent/request-error', async (payload, next) => {
    const downstream = await next();
    if (downstream !== undefined && downstream !== null) return downstream;

    try {
      const failure = payload?.failure;
      if (!failure) return downstream;
      const code = failure.code;
      if (code === undefined || !eligible(options, code)) return downstream;
      if (payload.signal?.aborted) return downstream;

      const agent = payload.agent;
      if (!agent) return downstream;

      const attempt = takeBudget(agent, payload.turn, payload.step);
      if (attempt === undefined) {
        logger?.warn?.(`tool-call-repair: budget spent for ${code} on turn ${payload.turn} step ${payload.step}`);
        return downstream;
      }

      const capped = Math.min(options.initialDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
      const jitter = 1 - options.jitterRatio + 2 * options.jitterRatio * Math.random();
      const delayMs = Math.round(Math.min(capped * jitter, options.maxDelayMs));

      logger?.warn?.(
        `tool-call-repair: attempt ${attempt} for ${code} on turn ${payload.turn} step ${payload.step} in ${delayMs}ms`,
      );

      if (delayMs > 0) await backoffDelay(delayMs, payload.signal);
      if (payload.signal?.aborted) return downstream;
      return { kind: 'retry' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger?.warn?.(`tool-call-repair: recovery hook failed: ${detail}`);
      return downstream;
    }
  });
}

/** Wrap one model stream so a truncated frame cannot leave the turn half-open. */
async function* repair(source: AsyncIterable<StreamChunk>, logger?: Logger): AsyncGenerator<StreamChunk> {
  const open = new Map<number, OpenBlock>();
  let finished = false;

  try {
    for await (const chunk of source) {
      if (typeof chunk !== 'object' || chunk === null) {
        yield chunk;
        continue;
      }
      const index = typeof chunk.index === 'number' ? chunk.index : undefined;

      if (chunk.type === 'block-start' && index !== undefined) {
        open.set(index, {
          type: String(chunk.blockType ?? 'text'),
          text: '',
          args: '',
          id: undefined,
          name: undefined,
        });
      } else if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && index !== undefined) {
        const block = open.get(index);
        if (block !== undefined) block.text += chunk.text ?? '';
      } else if (chunk.type === 'tool-call-delta' && index !== undefined) {
        const block = open.get(index);
        if (block !== undefined) {
          block.args += chunk.argumentsDelta ?? '';
          if (typeof chunk.id === 'string' && chunk.id.length > 0) block.id = chunk.id;
          if (typeof chunk.name === 'string' && chunk.name.length > 0) block.name = chunk.name;
        }
      } else if (chunk.type === 'block-end' && index !== undefined) {
        open.delete(index);
      } else if (chunk.type === 'finish') {
        finished = true;
        if (open.size > 0) {
          logger?.warn?.(`tool-call-repair: closing ${open.size} unpaired block(s) before finish`);
          for (const closing of openBlocks(open)) yield closing;
        }
      }

      yield chunk;
    }
  } catch (error) {
    const code = codeOf(error);
    // Codes that cannot be fixed by closing blocks must reach the caller.
    if (code === undefined || NEVER_RETRY.has(code)) throw error;

    const pending = [...open.values()];
    const hadToolCall = pending.some((block) => block.type === 'tool-call');
    logger?.warn?.(`tool-call-repair: stream broke with ${code}; closing ${pending.length} block(s) ${hadToolCall ? 'as tool-calls' : 'as text'}`);

    for (const closing of openBlocks(open)) yield closing;
    // tool-calls lets the loop dispatch the broken call: the tool rejects the
    // malformed arguments, the model reads that error and retries itself.
    yield { type: 'finish', reason: { kind: hadToolCall ? 'tool-calls' : 'max-tokens' } };
    return;
  }

  if (open.size > 0) {
    logger?.warn?.(`tool-call-repair: stream ended with ${open.size} unpaired block(s)`);
    for (const closing of openBlocks(open)) yield closing;
    if (!finished) yield { type: 'finish', reason: { kind: 'max-tokens' } };
  }
}