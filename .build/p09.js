
  /**
   * 定向补偿之一：钳输出上限。
   *
   * `agent/request` 是发请求前的 waterfall，`next()` 给出本轮要用的 config。
   * 白名单命中的供应商把 `maxTokens` 压到定向上限；provider / model /
   * reasoningEffort 一律原样返回——引擎会校验这三者不许被插件改。
   */
  ctx.on('agent/request', async (payload, next) => {
    const config = await next();
    if (typeof config !== 'object' || config === null) return config;

    const live = read();
    if (!isScoped(config.provider, live)) return config;

    const capped = clampMaxTokens(config, live.scopedMaxTokens);
    if (capped !== config) {
      logger?.warn?.(
        `tool-call-repair: ${config.provider} 的 maxTokens ${config.maxTokens} -> ${capped.maxTokens}（定向钳制）`,
      );
    }
    return capped;
  });

  // 同样一直注册：重试次数可能在挂载之后从 0 调高。
  ctx.on('agent/request-error', async (payload, next) => {
    const live = read();
    const scoped = isScoped(payload?.provider, live);

    const downstream = await next();
    if (downstream !== undefined && downstream !== null) {
      // 白名单供应商允许「下游已经决定重试」继续沿用；其余情况一律原样让位。
      if (!scoped || downstream.kind !== 'retry') return downstream;
    }

    try {
      // 定向供应商用更大的单 step 预算：这类中转站单次失败率高，全局默认
      // 的 5 次经常穿不过一次抖动。
      const limit = scoped ? live.scopedRetries : live.retries;
      if (limit <= 0) return downstream;

      const failure = payload?.failure;
      if (!failure) return downstream;
      const code = failure.code;
      if (code === undefined || !eligible(live, code)) return downstream;
      if (payload.signal?.aborted) return downstream;

      const agent = payload.agent;
      if (!agent) return downstream;

      const attempt = takeBudget(live, agent, payload.turn, payload.step, limit);
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
