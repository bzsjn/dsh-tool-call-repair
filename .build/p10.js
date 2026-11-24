
  /**
   * 续跑：`agent/turn-stopping` 在本轮边界、提交之前被 await，之后收件箱会被
   * 重新读一次。所以在监听器里 `agent.steer(...)` 推一条输入，本轮就会再跑
   * 一步，而不是停下来等用户开口。
   */
  ctx.on('agent/turn-stopping', (payload) => {
    const agent = payload?.agent;
    const sessionId = agent?.session?.id;
    if (sessionId === undefined) return;

    // 先摘标记再判开关：本轮被截断后如果用户关掉续跑、或者这一轮被中断
    // 没走到这里，标记都不该留到下一轮去误触发。
    if (!pending.delete(sessionId)) return;

    const live = read();
    if (!live.degenerate || !live.degResume) return;

    const turn = payload?.turn;
    let record = resumes.get(agent);
    if (record === undefined || record.turn !== turn) {
      record = { turn, used: 0 };
      resumes.set(agent, record);
    }
    if (record.used >= live.degResumeLimit) {
      logger?.warn?.(
        `tool-call-repair: 本轮退化续跑已达上限 ${live.degResumeLimit}，不再续跑（会话 ${sessionId}）`,
      );
      return;
    }
    record.used += 1;

    try {
      agent.steer(
        createUserMessage({
          content: [{ type: 'text', text: live.degResumeText }],
          // `form: 'notice'` 要求同时给 `summary`：客户端据此把它渲染成折叠的
          // context 行，而不是用户气泡。
          source: {
            kind: 'plugin:tool-call-repair',
            form: 'notice',
            summary: live.degResumeSummary,
          },
        }),
      );
      logger?.warn?.(
        `tool-call-repair: 退化续跑 ${record.used}/${live.degResumeLimit}（会话 ${sessionId}）`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger?.warn?.(`tool-call-repair: 续跑注入失败 ${detail}`);
    }
  });

  /**
   * 历史清洗：`agent/pre-step` 是发请求前的 waterfall，`decision.messages`
   * 就是这一轮要送出去的消息列表，可以改写。
   *
   * 只处理已经落库的空回答——本插件新加的空响应修复负责拦新的，这里负责
   * 把旧的从每次请求里摘出去。
   */
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const live = read();
    if (!live.historyClean) return decision;
    if (typeof decision !== 'object' || decision === null) return decision;

    const { messages, dropped } = cleanHistory(decision.messages, live);
    if (dropped === 0) return decision;

    logger?.warn?.(
      `tool-call-repair: 历史清洗 ${live.historyPlaceholder ? '替换' : '剔除'} ${dropped} 条空回答（turn ${payload?.turn}）`,
    );
    return { ...decision, messages };
  });
}
