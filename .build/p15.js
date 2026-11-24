
    // 越过供应商的输出上限继续写，而不是就此结束本轮。
    if (truncated && autoContinue && round < continueRounds && text !== '') {
      round += 1;
      carried += text;
      offset = topIndex + 1;
      // 原地追加，不置换 options.messages：上游冻结的是 options 对象本身，
      // 但数组仍可 push；整份冻结时才降级。
      try {
        const messages = Array.isArray(options.messages) ? options.messages : [];
        messages.push({ role: 'assistant', content: [{ type: 'text', text: carried }] });
        messages.push({ role: 'user', content: [{ type: 'text', text: '继续' }] });
        if (!Array.isArray(options.messages)) options.messages = messages;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger?.warn?.(
          `tool-call-repair: auto-continue could not arm; ending as max-tokens (${detail})`,
        );
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
        return;
      }
      logger?.warn?.(`tool-call-repair: auto-continue ${round}/${continueRounds}`);
      continue;
    }

    if (!finished) {
      yield { type: 'finish', reason: { kind: openToolCall ? 'tool-calls' : 'max-tokens' } };
      return;
    }
    if (truncated) {
      // tool-calls 会把断掉的调用交给循环派发：工具拒绝坏参数，模型读到错误
      // 后自己重来一次。
      const kind = broken !== undefined && openToolCall ? 'tool-calls' : 'max-tokens';
      yield { type: 'finish', reason: { kind } };
      return;
    }
    // 正常收尾：把上游的 finish 原样透传（带上 usage / replayState）。
    yield { type: 'finish', reason: upstreamReason ?? { kind: 'stop' } };
    return;
  }
}
