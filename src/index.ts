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

import z from '@deepseek-ai/schemastery';

interface ConfigShape {
  /** Keep chunks paired and close a truncated stream instead of failing it. */
  repairStream?: boolean;
  /** Retry failed model requests. `false` disables the whole retry layer. */
  retryEnabled?: boolean;
  /**
   * Dispatch a tool call whose arguments arrived truncated so the tool rejects
   * it and the model reads that error. `false` drops the call instead and ends
   * the turn as max-tokens.
   */
  dispatchTruncatedToolCalls?: boolean;
  /** 工具修复：参数截断时闭合协议并派发该调用，让模型读到错误后重写。 */
  '工具修复'?: boolean;
  /** 重试次数：连接或服务端失败的重试上限，0 表示不重试。 */
  '重试次数'?: number;
  /** token上限：本轮输出达到该值即按截断收尾，0 表示不干预。 */
  'token上限'?: number;
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
const NEVER_RETRY = new Set([
  'ABORTED',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_REPLAY_STATE',
  'NO_ADAPTER',
  'AUTH',
  'INVALID_REQUEST',
  'INVALID_CREDENTIAL',
  'QUOTA_EXCEEDED',
  'ACCOUNT_QUOTA_EXCEEDED',
]);

const DEFAULTS = {
  repairStream: true,
  retryEnabled: true,
  dispatchTruncatedToolCalls: true,
  maxRetries: 12,
  maxRetriesPerTurn: 40,
  codes: ['*'],
  initialDelayMs: 1000,
  maxDelayMs: 240000,
  jitterRatio: 0.2,
};

/** Schema the plugin manager renders as a form. `volatile()` fields are editable there. */
export const Config = z.object({
  工具修复: z.boolean().default(true).description('流层协议修复：补发缺失的 block-end，按 tool-calls 收尾并派发被截断的调用').volatile(),
  重试次数: z.natural().default(12).description('模型请求失败的重试上限，0 表示不重试').volatile(),
  token上限: z.natural().default(0).description('本轮输出字符预算，达到即截断收尾，0 表示不干预').volatile(),
  maxRetriesPerTurn: z.natural().default(40).description('每个 turn 加 step 的重试总预算').volatile(),
  codes: z.array(z.string()).default(['*']).description('参与重试的失败码，* 表示全部').volatile(),
  initialDelayMs: z.natural().default(1000).description('首次退避毫秒，之后指数翻倍').volatile(),
  maxDelayMs: z.natural().default(240000).description('单次退避上限毫秒').volatile(),
  jitterRatio: z.number().min(0).max(1).default(0.2).description('退避抖动比例，0 到 1').volatile(),
});

interface ResolvedConfig {
  /** 工具修复 */
  toolFix: boolean;
  /** 重试次数 */
  retries: number;
  retriesPerTurn: number;
  /** token上限 */
  tokenCap: number;
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

/**
 * Volatile schema fields arrive as cosmokit references ({ get, [write] }), not
 * plain values, because .volatile() is what makes a field editable in the
 * plugin manager. Read through the reference; leave plain values alone.
 */
function unwrap(value: unknown): unknown {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get: () => unknown }).get()
    : value;
}

function unwrapConfig(config: ConfigShape | undefined): ConfigShape {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config ?? {})) out[key] = unwrap(value);
  return out as ConfigShape;
}

function normalize(config?: ConfigShape): ResolvedConfig {
  const raw: ConfigShape = unwrapConfig(config);
  const codes = Array.isArray(raw.codes) ? raw.codes.map(String) : [...DEFAULTS.codes];

  // Chinese switches win when present; the English keys stay supported.
  const toolFix =
    raw['工具修复'] !== undefined
      ? raw['工具修复'] !== false
      : raw.repairStream !== false && raw.dispatchTruncatedToolCalls !== false;

  const retries = Math.floor(
    positive(raw['重试次数'] ?? (raw.retryEnabled === false ? 0 : raw.maxRetries), DEFAULTS.maxRetries),
  );

  const tokenCap = Math.floor(positive(raw['token上限'], 0));

  return {
    toolFix,
    retries,
    retriesPerTurn: Math.floor(positive(raw.maxRetriesPerTurn, DEFAULTS.maxRetriesPerTurn)),
    tokenCap,
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

function openBlocks(open: Map<number, OpenBlock>, dispatchTruncatedToolCalls: boolean): StreamChunk[] {
  const closing: StreamChunk[] = [];
  for (const [index, block] of open) {
    let content: { type: string; [key: string]: unknown };
    if (block.type === 'tool-call') {
      // Dropping the call is the alternative to dispatching it: the turn then
      // ends as max-tokens because no tool-call block reaches the loop.
      if (!dispatchTruncatedToolCalls) continue;
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

/** Failure code carried by a terminal error finish frame, when there is one. */
function failureCodeOf(reason: StreamChunk['reason']): string | undefined {
  if (typeof reason !== 'object' || reason === null || reason.kind !== 'error') return undefined;
  const failure = (reason as { failure?: unknown }).failure;
  if (typeof failure !== 'object' || failure === null) return undefined;
  const code = (failure as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Whether this frame carries model content that the caller already consumed. */
function isContentFrame(chunk: StreamChunk): boolean {
  return (
    chunk.type === 'block-start' ||
    chunk.type === 'block-end' ||
    (typeof chunk.type === 'string' && chunk.type.endsWith('-delta'))
  );
}

export const name = 'tool-call-repair';

export function apply(ctx: PluginContext, config?: ConfigShape): void {
  // Volatile fields can change while the plugin stays mounted, so options are
  // re-read per request rather than captured once at mount.
  const read = (): ResolvedConfig => normalize(config);
  const logger = ctx.logger;
  const steps = new WeakMap<object, StepBudget>();
  const turns = new WeakMap<object, TurnBudget>();

  // Registered unconditionally: 工具修复 may be switched on after mount.
  ctx.on('llm/stream', (_options, next) => {
    const live = read();
    if (!live.toolFix) return next();
    return repair(next(), logger, live.tokenCap, live.toolFix);
  });

  function takeBudget(
    live: ResolvedConfig,
    agent: object,
    turn: number | undefined,
    step: number | undefined,
  ): number | undefined {
    let turnRecord = turns.get(agent);
    if (turnRecord === undefined || turnRecord.turn !== turn) {
      turnRecord = { turn, used: 0 };
      turns.set(agent, turnRecord);
    }
    if (turnRecord.used >= live.retriesPerTurn) return undefined;

    let stepRecord = steps.get(agent);
    if (stepRecord === undefined || stepRecord.turn !== turn || stepRecord.step !== step) {
      stepRecord = { turn, step, used: 0 };
      steps.set(agent, stepRecord);
    }
    if (stepRecord.used >= live.retries) return undefined;

    stepRecord.used += 1;
    turnRecord.used += 1;
    return stepRecord.used;
  }

  // Also unconditional: 重试次数 may be raised from 0 after mount.
  ctx.on('agent/request-error', async (payload, next) => {
    const downstream = await next();
    if (downstream !== undefined && downstream !== null) return downstream;

    try {
      const live = read();
      if (live.retries <= 0) return downstream;

      const failure = payload?.failure;
      if (!failure) return downstream;
      const code = failure.code;
      if (code === undefined || !eligible(live, code)) return downstream;
      if (payload.signal?.aborted) return downstream;

      const agent = payload.agent;
      if (!agent) return downstream;

      const attempt = takeBudget(live, agent, payload.turn, payload.step);
      if (attempt === undefined) {
        logger?.warn?.(`tool-call-repair: budget spent for ${code} on turn ${payload.turn} step ${payload.step}`);
        return downstream;
      }

      const capped = Math.min(live.initialDelayMs * 2 ** (attempt - 1), live.maxDelayMs);
      const jitter = 1 - live.jitterRatio + 2 * live.jitterRatio * Math.random();
      const delayMs = Math.round(Math.min(capped * jitter, live.maxDelayMs));

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
async function* repair(
  source: AsyncIterable<StreamChunk>,
  logger: Logger | undefined,
  tokenCap: number,
  toolFix: boolean,
): AsyncGenerator<StreamChunk> {
  const open = new Map<number, OpenBlock>();
  let finished = false;
  let produced = false;
  let spent = 0;

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
        const added = chunk.text ?? '';
        if (block !== undefined) block.text += added;
        spent += added.length;
      } else if (chunk.type === 'tool-call-delta' && index !== undefined) {
        const block = open.get(index);
        const added = chunk.argumentsDelta ?? '';
        if (block !== undefined) {
          block.args += added;
          if (typeof chunk.id === 'string' && chunk.id.length > 0) block.id = chunk.id;
          if (typeof chunk.name === 'string' && chunk.name.length > 0) block.name = chunk.name;
        }
        spent += added.length;
      } else if (chunk.type === 'block-end' && index !== undefined) {
        open.delete(index);
      } else if (chunk.type === 'finish') {
        finished = true;
        const code = failureCodeOf(chunk.reason);
        if (code !== undefined && !NEVER_RETRY.has(code) && produced) {
          // Output already reached the caller; a retry would duplicate it.
          // Close the frame and end the turn instead of failing the task.
          const pending = [...open.values()];
          const hadToolCall = pending.some((block) => block.type === 'tool-call');
          logger?.warn?.(
            `tool-call-repair: ${code} after output; closing ${pending.length} block(s) as ${hadToolCall ? 'tool-calls' : 'max-tokens'}`,
          );
          for (const closing of openBlocks(open, toolFix)) yield closing;
          yield { type: 'finish', reason: { kind: hadToolCall ? 'tool-calls' : 'max-tokens' } };
          return;
        }
        if (open.size > 0) {
          logger?.warn?.(`tool-call-repair: closing ${open.size} unpaired block(s) before finish`);
          for (const closing of openBlocks(open, toolFix)) yield closing;
        }
      }

      if (isContentFrame(chunk)) produced = true;
      yield chunk;

      if (tokenCap > 0 && spent >= tokenCap) {
        const closing = openBlocks(open, toolFix);
        const hadToolCall = closing.some((c) => c.block?.type === 'tool-call');
        logger?.warn?.(`tool-call-repair: token上限 reached ${spent}/${tokenCap}; truncating the turn`);
        for (const frame of closing) yield frame;
        yield { type: 'finish', reason: { kind: hadToolCall ? 'tool-calls' : 'max-tokens' } };
        return;
      }
    }
  } catch (error) {
    const code = codeOf(error);
    // Codes that cannot be fixed by closing blocks must reach the caller.
    if (code === undefined || NEVER_RETRY.has(code)) throw error;
    // Nothing reached the caller yet: let the retry hook own this attempt.
    if (!produced) throw error;

    const pending = [...open.values()];
    const hadToolCall = pending.some((block) => block.type === 'tool-call');
    logger?.warn?.(`tool-call-repair: stream broke with ${code}; closing ${pending.length} block(s) ${hadToolCall ? 'as tool-calls' : 'as text'}`);

    for (const closing of openBlocks(open, toolFix)) yield closing;
    // tool-calls lets the loop dispatch the broken call: the tool rejects the
    // malformed arguments, the model reads that error and retries itself.
    yield { type: 'finish', reason: { kind: hadToolCall ? 'tool-calls' : 'max-tokens' } };
    return;
  }

  if (open.size > 0) {
    logger?.warn?.(`tool-call-repair: stream ended with ${open.size} unpaired block(s)`);
    for (const closing of openBlocks(open, toolFix)) yield closing;
    if (!finished) yield { type: 'finish', reason: { kind: 'max-tokens' } };
  }
}