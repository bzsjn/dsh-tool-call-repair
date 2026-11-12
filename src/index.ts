/**
 * dsh-tool-call-repair
 *
 * Keeps a turn alive when a model request fails in a recoverable way.
 *
 * Observed failures on an OpenAI/Anthropic compatible gateway:
 *  - a tool_use block is closed before its input_json_delta finishes, so the
 *    adapter drops the call and raises MALFORMED_RESPONSE (not in the default
 *    retryable set, so the turn died);
 *  - a completed response carries no content (EMPTY_RESPONSE);
 *  - the stream ends early (STREAM_CLOSED / PI_AI_ERROR);
 *  - the same request repeated a moment later usually succeeds, which means
 *    these are transient transport faults rather than deterministic bugs.
 *
 * Policy: retry anything that could plausibly succeed on a second attempt,
 * with exponential backoff and a bounded budget. Codes that cannot be fixed by
 * repeating the identical request (user abort, context overflow, invalid
 * replay state, missing adapter) are never retried. Truncated JSON is never
 * rewritten: guessing the missing tail could change the command that runs.
 */

/** Public configuration accepted from `cordis.patch.yml`. */
export interface Config {
  /** Retries allowed per turn+step. `0` disables retrying but keeps logging. */
  maxRetries?: number;
  /** Retries allowed across one whole turn, so several steps cannot each burn a full budget. */
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

/** Payload delivered by the `agent/request-error` waterfall. */
export interface RequestErrorPayload {
  agent?: object;
  turn?: number;
  step?: number;
  provider?: string;
  failure?: Failure;
  signal?: { aborted?: boolean; addEventListener?: Function; removeEventListener?: Function };
}

export type RequestErrorAction = { kind: 'retry' } | undefined;

export interface PluginContext {
  logger?: Logger;
  on(
    event: 'agent/request-error',
    listener: (
      payload: RequestErrorPayload,
      next: () => Promise<RequestErrorAction>,
    ) => Promise<RequestErrorAction>,
  ): void;
}

/** Codes where repeating the identical request cannot help. */
const NEVER_RETRY = new Set(['ABORTED', 'CONTEXT_WINDOW_EXCEEDED', 'INVALID_REPLAY_STATE', 'NO_ADAPTER']);

const DEFAULTS = {
  maxRetries: 2,
  maxRetriesPerTurn: 5,
  codes: ['*'],
  initialDelayMs: 250,
  maxDelayMs: 4000,
  jitterRatio: 0.25,
};

interface ResolvedConfig {
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

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalize(config?: Config): ResolvedConfig {
  const raw = config ?? {};
  const codes = Array.isArray(raw.codes) ? raw.codes.map(String) : [...DEFAULTS.codes];
  return {
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

export const name = 'tool-call-repair';

export function apply(ctx: PluginContext, config?: Config): void {
  const options = normalize(config);
  const logger = ctx.logger;
  const steps = new WeakMap<object, StepBudget>();
  const turns = new WeakMap<object, TurnBudget>();

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
    // Another recovery hook may decide first; a throw belongs to the caller.
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
        logger?.warn?.(
          `tool-call-repair: budget spent for ${code} on turn ${payload.turn} step ${payload.step}`,
        );
        return downstream;
      }

      const exponential = options.initialDelayMs * 2 ** (attempt - 1);
      const capped = Math.min(exponential, options.maxDelayMs);
      const jitter = 1 - options.jitterRatio + 2 * options.jitterRatio * Math.random();
      const delayMs = Math.round(Math.min(capped * jitter, options.maxDelayMs));

      logger?.warn?.(
        `tool-call-repair: attempt ${attempt} for ${code} on turn ${payload.turn} step ${payload.step} in ${delayMs}ms`,
      );

      if (delayMs > 0) await backoffDelay(delayMs, payload.signal);
      if (payload.signal?.aborted) return downstream;

      return { kind: 'retry' };
    } catch (error) {
      // The recovery hook must never break the turn itself.
      const detail = error instanceof Error ? error.message : String(error);
      logger?.warn?.(`tool-call-repair: recovery hook failed: ${detail}`);
      return downstream;
    }
  });
}