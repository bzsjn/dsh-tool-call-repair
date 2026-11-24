
        if (chunk.type === 'block-start' && index !== undefined) {
          open.set(index, {
            type: String(chunk.blockType ?? 'text'),
            text: '',
            args: '',
            id: undefined,
            name: undefined,
          });
        } else if (
          (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') &&
          index !== undefined
        ) {
          const block = open.get(index);
          const added = chunk.text ?? '';
          if (block !== undefined) block.text += added;
          if (chunk.type === 'text-delta') text += added;
          if (chunk.type === 'reasoning-delta') accumulated += added;
          if (added.trim().length > 0) visible = true;
          spent += added.length;
        } else if (chunk.type === 'tool-call-delta' && index !== undefined) {
          const block = open.get(index);
          const added = chunk.argumentsDelta ?? '';
          visible = true;
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
          upstreamReason = chunk.reason;
          const code = failureCodeOf(chunk.reason);
          if (code !== undefined && !NEVER_RETRY.has(code) && produced) {
            // 输出已经交出去了，重试会重复一遍；把打开的块收口后按截断结束。
            const pendingBlocks = [...open.values()];
            const hadToolCall = pendingBlocks.some((block) => block.type === 'tool-call');
            logger?.warn?.(
              `tool-call-repair: ${code} after output; closing ${pendingBlocks.length} block(s) as ${hadToolCall ? 'tool-calls' : 'max-tokens'}`,
            );
            for (const closing of openBlocks(open, toolFix)) yield shift(closing);
            yield { type: 'finish', reason: { kind: hadToolCall ? 'tool-calls' : 'max-tokens' } };
            return;
          }
          if (open.size > 0) {
            logger?.warn?.(`tool-call-repair: closing ${open.size} unpaired block(s) before finish`);
            for (const closing of openBlocks(open, toolFix)) yield shift(closing);
          }
          truncated = chunk.reason?.kind === 'max-tokens';
          continue;
        }

        if (isContentFrame(chunk)) produced = true;
