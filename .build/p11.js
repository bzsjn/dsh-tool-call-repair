
/** 包一层上游流：截断、空响应、思考复读都不许让本轮停在半个状态上。 */
async function* repair(next, options, logger, live, onDegenerate) {
  const { tokenCap, toolFix, autoContinue, continueRounds, emptyResponse, emptyRetries, degenerate } = live;
  // 定向供应商单独一套空响应预算：它们的空回答更频繁，值得多试几次。
  const scoped = isScoped(options?.provider, live);
  const emptyLimit = scoped ? live.scopedEmptyRetries : emptyRetries;
  const sessionId = options?.sessionId;
  let round = 0;
  let offset = 0;
  let spent = 0;
  let produced = false;
  let carried = '';

  for (;;) {
    const open = new Map();
    const queue = [];
    let finished = false;
    let truncated = false;
    let upstreamReason;
    let text = '';
    let topIndex = -1;
    let accumulated = '';
    let visible = false;
    let broken;

    const shift = (chunk) =>
      offset === 0 || typeof chunk.index !== 'number'
        ? chunk
        : { ...chunk, index: chunk.index + offset };

    const iterator = next()[Symbol.asyncIterator]();

    try {
      for (;;) {
        const step = queue.length > 0 ? queue.shift() : await iterator.next();
        if (step.done) break;
        const chunk = step.value;
        if (typeof chunk !== 'object' || chunk === null) {
          yield chunk;
          continue;
        }
        const index = typeof chunk.index === 'number' ? chunk.index : undefined;
        if (index !== undefined && index > topIndex) topIndex = index;
