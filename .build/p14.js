
    } catch (error) {
      const code = codeOf(error);
      // 关块修不好的失败码必须原样往上抛。
      if (code === undefined || NEVER_RETRY.has(code)) throw error;
      // 还没交出去任何内容：让重试钩子拿下这一轮。
      if (!produced) throw error;
      // 已经交出去内容了：当作截断，交给下面统一的续写 / 收尾决定。
      broken = code;
      truncated = true;
      logger?.warn?.(`tool-call-repair: stream broke with ${code}; treating it as truncated`);
    }

    const openToolCall = [...open.values()].some((block) => block.type === 'tool-call');
    if (open.size > 0) {
      logger?.warn?.(`tool-call-repair: stream ended with ${open.size} unpaired block(s)`);
      for (const closing of openBlocks(open, toolFix)) yield shift(closing);
    }

    // 上游给了完成帧，却一个可见内容都没有：转成可重试错误，别落库成一条
    // 空回答（那会让历史被污染，后面每一轮都跟着空）。
    const emptyStop = emptyResponse && !visible && (!finished || upstreamReason?.kind === 'stop');
    if (emptyStop) {
      const streak = bumpEmptyStreak();
      if (emptyRetries > 0 && streak <= emptyRetries) {
        logger?.warn?.(
          `tool-call-repair: 上游返回零内容的完成响应 ${streak}/${emptyRetries}，转成 EMPTY_RESPONSE`,
        );
        yield emptyResponseFrame();
        return;
      }
      logger?.warn?.(
        `tool-call-repair: 空响应次数已用尽（${streak}/${emptyRetries}），不再重试，按 stop 收尾`,
      );
    } else if (visible) {
      resetEmptyStreak();
    }
