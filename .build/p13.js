
        // 思考段复读：先看下一格还是不是思考，确定这一段是不是真在打转。
        if (degenerate && chunk.type === 'reasoning-delta') {
          const hit = findDegenerateLine(
            accumulated,
            live.degFragments,
            live.degThreshold,
            live.degInline,
          );
          if (hit !== null) {
            // 往前探一格：命中行之后若是正文或工具调用，说明模型只是思考里
            // 顺口应答了一句，不算打转。block 边界帧不具判别力，穿透继续探。
            let probe = await iterator.next();
            queue.push(probe);
            let nextChunk = probe.done ? undefined : probe.value;
            let hops = 0;
            while (
              nextChunk !== undefined &&
              hops < 3 &&
              nextChunk.type !== 'text-delta' &&
              nextChunk.type !== 'tool-call-delta' &&
              nextChunk.type !== 'reasoning-delta' &&
              nextChunk.type !== 'finish'
            ) {
              hops += 1;
              probe = await iterator.next();
              queue.push(probe);
              nextChunk = probe.done ? undefined : probe.value;
            }
            const escaped =
              nextChunk !== undefined &&
              (nextChunk.type === 'text-delta' || nextChunk.type === 'tool-call-delta');
            if (!escaped) {
              // 触发点本身照常放行；要掐掉的是它之后的复读。
              yield shift(chunk);
              logger?.warn?.(
                `tool-call-repair: 思考段复读「${hit}」，截断本轮并按 max-tokens 收尾`,
              );
              for (const closing of openBlocks(open, toolFix)) yield shift(closing);
              // 关键：这里绝不能用 stop —— 裸 stop + 空内容会被当成一次成功的
              // 空回答落库。用 max-tokens 走"截断"语义，上层才会续或重试。
              yield { type: 'finish', reason: { kind: 'max-tokens' } };
              onDegenerate(sessionId);
              return;
            }
            logger?.warn?.(`tool-call-repair: 命中行之后转入正文/工具，不拦截「${hit}」`);
          }
        }

        yield shift(chunk);

        if (tokenCap > 0 && spent >= tokenCap) {
          const closing = openBlocks(open, toolFix);
          const hadToolCall = closing.some((c) => c.block?.type === 'tool-call');
          logger?.warn?.(`tool-call-repair: token上限 reached ${spent}/${tokenCap}; truncating the turn`);
          for (const frame of closing) yield shift(frame);
          yield { type: 'finish', reason: { kind: hadToolCall ? 'tool-calls' : 'max-tokens' } };
          return;
        }
      }
