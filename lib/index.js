// Compiled output of src/index.ts. Keep the two in sync when editing.
//
// Retries model requests that failed in a recoverable way, with exponential
// backoff and a bounded budget, so a transient gateway fault cannot end the
// whole turn. Truncated tool arguments are never rewritten.

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

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalize(config) {
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

function eligible(options, code) {
  if (NEVER_RETRY.has(code)) return false;
  return options.anyCode || options.codes.has(code);
}

/** Delay that resolves early when the turn is aborted. */
function backoffDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done);
  });
}

export const name = 'tool-call-repair';

export function apply(ctx, config) {
  const options = normalize(config);
  const logger = ctx.logger;
  const steps = new WeakMap();
  const turns = new WeakMap();

  function takeBudget(agent, turn, step) {
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