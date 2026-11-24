
/**
 * 这条消息是不是一份「空回答」。
 *
 * 空回答有两种落库形态：`content: []`（最常见），以及内容数组里只有空白
 * 文本。带 tool-call 或 reasoning 块的不算空——模型确实干了活的轮次不能
 * 被当成污染抹掉。
 */
function isBlankAssistant(message) {
  if (typeof message !== 'object' || message === null) return false;
  if (message.role !== 'assistant') return false;

  const content = message.content;
  if (content === undefined || content === null) return true;
  if (typeof content === 'string') return content.trim() === '';
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return true;

  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const type = part.type;
    if (type === 'tool-call' || type === 'reasoning') return false;
    if (type === 'text' && String(part.text ?? '').trim().length > 0) return false;
  }
  return true;
}

/** 用一条极简文本顶替空回答，保住 user/assistant 交替。 */
function placeholderFor(message, text) {
  return { ...message, content: [{ type: 'text', text }] };
}

/**
 * 清洗历史消息：剔除或替换 content 为空的 assistant 消息。
 *
 * 空回答一旦进了历史，后续每次请求都会把它带给上游；有的上游对这种
 * assistant 消息直接回 stop + 零内容，于是空转自我强化。这里只改「发出去
 * 的消息」，不动磁盘上的会话记录，随时可以关开关回退。
 */
function cleanHistory(messages, live) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, dropped: 0 };

  let dropped = 0;
  const cleaned = [];
  for (const message of messages) {
    if (!isBlankAssistant(message)) {
      cleaned.push(message);
      continue;
    }
    dropped += 1;
    if (live.historyPlaceholder) cleaned.push(placeholderFor(message, live.historyPlaceholderText));
  }
  return { messages: dropped > 0 ? cleaned : messages, dropped };
}

export const name = 'tool-call-repair';

export function apply(ctx, config) {
  // volatile 字段挂载后仍可改，所以每个请求都重新读一次配置。
  const read = () => normalize(config);
  const logger = ctx.logger;
  const steps = new WeakMap();
  const turns = new WeakMap();
  const pending = new Set();
  const resumes = new WeakMap();

  // 一直注册：这几个开关都可能在挂载之后才被打开。
  ctx.on('llm/stream', (options, next) => {
    const live = read();
    if (!live.toolFix && !live.autoContinue && !live.emptyResponse && !live.degenerate) return next();
    return repair(next, options, logger, live, (sessionId) => {
      if (sessionId !== undefined) pending.add(sessionId);
    });
  });

  function takeBudget(live, agent, turn, step, stepLimit) {
    let turnRecord = turns.get(agent);
    if (turnRecord === undefined || turnRecord.turn !== turn) {
      turnRecord = { turn, used: 0 };
      turns.set(agent, turnRecord);
    }
    if (turnRecord.used >= live.retriesPerTurn) return undefined;

    let stepRecord = steps.get(agent);
    if (stepRecord === undefined || stepRecord.turn !== turn || stepRecord.step !== step) {
      stepRecord = { turn, step, used: 0 };
      steps.set(agent, stepRecord);
    }
    // 定向供应商可以用更大的单 step 预算，但仍然受 turn 总预算约束。
    const cap = stepLimit === undefined ? live.retries : stepLimit;
    if (stepRecord.used >= cap) return undefined;

    stepRecord.used += 1;
    turnRecord.used += 1;
    return stepRecord.used;
  }
