
  // 同样一直注册：重试次数可能在挂载之后从 0 调高。
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
        logger?.warn?.(
          `tool-call-repair: budget spent for ${code} on turn ${payload.turn} step ${payload.step}`,
        );
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
