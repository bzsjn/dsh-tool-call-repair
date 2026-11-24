/**
 * dsh-tool-call-repair 0.5.0
 *
 * 一个 llm/stream 出口同时管四件事：
 *
 * 1. 流层协议修复：上游把工具参数截断时补发 block-end，按 tool-calls /
 *    max-tokens 收尾，而不是让整轮失败。残缺参数原样派发，由工具报错、
 *    模型读到错误后自己重写。
 * 2. 空响应修复：上游回了 stop 却一个内容块都没有，转成 EMPTY_RESPONSE（连续次数受「空响应次数」约束）
 *    抛给重试层，不再静默落库成一条空回答。
 * 3. 退化拦截 + 续跑：思考段陷入短句复读时收口本轮，按 max-tokens 收尾，
 *    绝不伪造 stop；本轮边界用 agent.steer 推一条输入让本轮继续。
 * 4. agent/request-error：指数退避 + 有界预算重试。
 *
 * 任何一层都不改写截断的 JSON：猜缺失的尾巴可能改掉真正要执行的命令。
 */
import z from '@deepseek-ai/schemastery';

// dsh-llm 是 DSH 运行时注入的内置包，不总能在插件自己的 node_modules 里解析。
// 有就用真的（保证与引擎的 UserMessage 结构一致），没有就退到等价的最小红对象，
// 免得整个插件因为一个可选依赖炸掉。
let createUserMessage;
try {
  ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'));
} catch {
  createUserMessage = (input) => ({ role: 'user', ...input });
}

/** 重试也修不好的失败码，必须原样抛给调用方。 */
const NEVER_RETRY = new Set([
  'ABORTED',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_REPLAY_STATE',
  'NO_ADAPTER',
  'AUTH',
  'INVALID_REQUEST',
  'INVALID_CREDENTIAL',
  'QUOTA_EXCEEDED',
  'ACCOUNT_QUOTA_EXCEEDED',
]);

/**
 * 默认填充短句表。只收纯应答语，不收「写。查。看。做。」这类实义动词：
 * 思考里出现一个动词单句是正常的，拦掉会把有效推理截断。
 */
const DEFAULT_FRAGMENTS = [
  '好。',
  '好的。',
  '对。',
  '对的。',
  '是的。',
  '嗯。',
  '收到。',
  '明白。',
  '继续。',
  '确认。',
  'ok.',
  'okay.',
  'done.',
  'sure.',
  'got it.',
];

const DEFAULTS = {
  repairStream: true,
  retryEnabled: true,
  dispatchTruncatedToolCalls: true,
  maxRetries: 12,
  maxRetriesPerTurn: 40,
  codes: ['*'],
  initialDelayMs: 1000,
  maxDelayMs: 240000,
  jitterRatio: 0.2,
  autoContinue: false,
  continueRounds: 3,
  emptyResponse: true,
  emptyRetries: 3,
  degenerate: true,
  degThreshold: 2,
  degInline: false,
  degResume: true,
  degResumeLimit: 3,
  degResumeText: '上一段思考陷入复读，已截断。请直接给出结论或调用工具，不要重复短句。',
  degResumeSummary: '已截断复读段',
  historyClean: true,
  historyPlaceholder: true,
  historyPlaceholderText: '（本轮模型未产出内容）',
};

/** 插件管理页渲染成表单的 schema；`.volatile()` 的字段可以在页面上改。 */
export const Config = z.object({
  工具修复: z.boolean().default(true).description('流层协议修复：补发缺失的 block-end，按 tool-calls 收尾并派发被截断的调用').volatile(),
  自动续写: z.boolean().default(false).description('达到输出上限后自动再发一次请求接着写，不中断本轮').volatile(),
  续写轮数: z.natural().default(3).description('自动续写的最大轮数，到顶即按截断收尾').volatile(),
  重试次数: z.natural().default(12).description('模型请求失败的重试上限，0 表示不重试').volatile(),
  token上限: z.natural().default(0).description('本轮输出字符预算，达到即截断收尾，0 表示不干预').volatile(),
  空响应修复: z.boolean().default(true).description('上游回了 stop 却零内容时抛出 EMPTY_RESPONSE 交给重试层，不再静默落库').volatile(),
  空响应次数: z.natural().default(3).description('连续空响应的重试上限，0 表示不重试').volatile(),
  退化检测: z.boolean().default(true).description('思考段陷入短句复读时截断本轮').volatile(),
  退化阈值: z.natural().default(2).description('连续出现几次填充短句才判为复读，1 最激进').volatile(),
  退化词表: z.array(z.string()).default([...DEFAULT_FRAGMENTS]).description('整行匹配的填充短句表').volatile(),
  退化续跑: z.boolean().default(true).description('截断后在本轮边界推一条输入让本轮继续').volatile(),
  退化续跑文案: z.string().default(DEFAULTS.degResumeText).description('续跑时注入的正文').volatile(),
  退化续跑上限: z.natural().default(3).description('同一轮最多续跑几次').volatile(),
  历史清洗: z.boolean().default(true).description('发请求前剔除历史里 content 为空的 assistant 消息，阻止空回答污染后续轮次').volatile(),
  历史清洗占位: z.boolean().default(true).description('清洗时用一条极简文本替身顶替空消息，保住 user/assistant 交替；关掉则直接删除').volatile(),
  历史清洗文本: z.string().default(DEFAULTS.historyPlaceholderText).description('占位替身的正文').volatile(),
  maxRetriesPerTurn: z.natural().default(40).description('每个 turn 加 step 的重试总预算').volatile(),
  codes: z.array(z.string()).default(['*']).description('参与重试的失败码，* 表示全部').volatile(),
  initialDelayMs: z.natural().default(1000).description('首次退避毫秒，之后指数翻倍').volatile(),
  maxDelayMs: z.natural().default(240000).description('单次退避上限毫秒').volatile(),
  jitterRatio: z.number().min(0).max(1).default(0.2).description('退避抖动比例，0 到 1').volatile(),
});

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * `.volatile()` 字段进来的是 cosmokit 引用（{ get, [write] }）而不是普通值。
 * 有 get 就读一次，其余原样返回。
 */
function unwrap(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value;
}

function unwrapConfig(config) {
  const out = {};
  for (const [key, value] of Object.entries(config ?? {})) out[key] = unwrap(value);
  return out;
}

function normalize(config) {
  const raw = unwrapConfig(config);
  const codes = Array.isArray(raw.codes) ? raw.codes.map(String) : [...DEFAULTS.codes];

  // 中文开关优先，英文键继续兼容。
  const toolFix =
    raw['工具修复'] !== undefined
      ? raw['工具修复'] !== false
      : raw.repairStream !== false && raw.dispatchTruncatedToolCalls !== false;

  const retries = Math.floor(
    positive(raw['重试次数'] ?? (raw.retryEnabled === false ? 0 : raw.maxRetries), DEFAULTS.maxRetries),
  );
  const tokenCap = Math.floor(positive(raw['token上限'], 0));
  const autoContinue =
    raw['自动续写'] !== undefined ? raw['自动续写'] === true : raw.autoContinue === true;
  const continueRounds = Math.floor(
    positive(raw['续写轮数'] ?? raw.continueRounds, DEFAULTS.continueRounds),
  );

  const emptyResponse =
    raw['空响应修复'] !== undefined ? raw['空响应修复'] === true : raw.repairEmptyResponse !== false;
  const emptyRetries = Math.floor(
    positive(raw['空响应次数'] ?? raw.emptyResponseRetries, DEFAULTS.emptyRetries),
  );
  const degenerate =
    raw['退化检测'] !== undefined ? raw['退化检测'] === true : raw.degenerate !== false;
  const degThreshold = Math.floor(
    positive(raw['退化阈值'] ?? raw.degThreshold, DEFAULTS.degThreshold),
  );
  const degRaw = raw['退化词表'] ?? raw.degFragments;
  const degFragments = Array.isArray(degRaw) ? degRaw.map(String) : [...DEFAULT_FRAGMENTS];
  const degResume =
    raw['退化续跑'] !== undefined ? raw['退化续跑'] === true : raw.degResume !== false;
  const degTextRaw = raw['退化续跑文案'] ?? raw.degResumeText;
  const degResumeText =
    typeof degTextRaw === 'string' && degTextRaw.length > 0 ? degTextRaw : DEFAULTS.degResumeText;
  const degResumeLimit = Math.floor(
    positive(raw['退化续跑上限'] ?? raw.degResumeLimit, DEFAULTS.degResumeLimit),
  );

  const historyClean =
    raw['历史清洗'] !== undefined ? raw['历史清洗'] === true : raw.historyClean !== false;
  const historyPlaceholder =
    raw['历史清洗占位'] !== undefined
      ? raw['历史清洗占位'] === true
      : raw.historyPlaceholder !== false;
  const historyTextRaw = raw['历史清洗文本'] ?? raw.historyPlaceholderText;
  const historyPlaceholderText =
    typeof historyTextRaw === 'string' && historyTextRaw.length > 0
      ? historyTextRaw
      : DEFAULTS.historyPlaceholderText;

  return {
    toolFix,
    retries,
    retriesPerTurn: Math.floor(positive(raw.maxRetriesPerTurn, DEFAULTS.maxRetriesPerTurn)),
    tokenCap,
    autoContinue,
    continueRounds,
    emptyResponse,
    emptyRetries,
    degenerate,
    degThreshold,
    degFragments,
    degInline: raw.degInline === true,
    degResume,
    degResumeText,
    degResumeSummary:
      typeof raw.degResumeSummary === 'string' ? raw.degResumeSummary : DEFAULTS.degResumeSummary,
    degResumeLimit,
    historyClean,
    historyPlaceholder,
    historyPlaceholderText,
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

function codeOf(error) {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

/** 退避等待；本轮被取消时立即返回。 */
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

/** 把还在打开的块按类型收口，返回要补发的 block-end 帧。 */
function openBlocks(open, dispatchTruncatedToolCalls) {
  const closing = [];
  for (const [index, block] of open) {
    let content;
    if (block.type === 'tool-call') {
      // 丢弃被截断的调用是派发之外的另一条路：本轮之后会因为没有 tool-call
      // 块而按 max-tokens 收尾。
      if (!dispatchTruncatedToolCalls) continue;
      // 原样透传（可能残缺的）参数文本：工具会拒绝它，错误回到模型手上，
      // 模型自己重写一次。
      content = {
        type: 'tool-call',
        id: block.id ?? '',
        name: block.name ?? '',
        arguments: block.args.length > 0 ? block.args : '{}',
      };
    } else if (block.type === 'reasoning') {
      content = { type: 'reasoning', text: block.text };
    } else {
      content = { type: 'text', text: block.text };
    }
    closing.push({ type: 'block-end', index, block: content });
  }
  open.clear();
  return closing;
}

/** 终止帧里携带的失败码（有的话）。 */
function failureCodeOf(reason) {
  if (typeof reason !== 'object' || reason === null || reason.kind !== 'error') return undefined;
  const failure = reason.failure;
  if (typeof failure !== 'object' || failure === null) return undefined;
  const code = failure.code;
  return typeof code === 'string' ? code : undefined;
}

/** 这一帧是否携带了模型产出的内容。 */
function isContentFrame(chunk) {
  return (
    chunk.type === 'block-start' ||
    chunk.type === 'block-end' ||
    (typeof chunk.type === 'string' && chunk.type.endsWith('-delta'))
  );
}

/**
 * 在累积文本里找连续出现的填充短句。
 *
 * 按行 trim + 小写后整行比对；空行既不计数也不打断连续。连续命中累计到
 * `threshold` 即返回那一行的原文，未命中返回 null。
 */
function findDegenerateLine(text, fragments, threshold, inlineRepeat) {
  if (!Array.isArray(fragments) || fragments.length === 0) return null;
  if (!(threshold > 0)) return null;

  const set = new Set();
  for (const fragment of fragments) {
    const normalized = String(fragment).trim().toLowerCase();
    if (normalized.length > 0) set.add(normalized);
  }
  if (set.size === 0) return null;

  let streak = 0;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const key = line.toLowerCase();

    let hit = set.has(key);
    if (!hit && inlineRepeat) {
      // 同一行里连续重复同一短句也算命中。
      for (const fragment of set) {
        if (key.length < fragment.length * 2) continue;
        const times = key.split(fragment).length - 1;
        if (times >= threshold) {
          hit = true;
          break;
        }
      }
    }

    if (!hit) {
      streak = 0;
      continue;
    }
    streak += 1;
    if (streak >= threshold) return line;
  }
  return null;
}

/** 上游给了完成帧、却一个可见内容都没有时补发的终止帧。 */
function emptyResponseFrame() {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: 'EMPTY_RESPONSE',
        message: 'tool-call-repair: 上游返回零内容的完成响应',
      },
    },
  };
}


/**
 * 连续空响应的计数。跨 repair() 调用保留，因为每次重试都会新建一条流。
 * 有真实产出时清零；隔得太久也清零，免得很久之后的一轮被旧账拖累。
 */
const EMPTY_STREAK = { count: 0, at: 0 };
const EMPTY_STREAK_WINDOW_MS = 120000;

function emptyStreak() {
  if (Date.now() - EMPTY_STREAK.at > EMPTY_STREAK_WINDOW_MS) EMPTY_STREAK.count = 0;
  return EMPTY_STREAK.count;
}

function bumpEmptyStreak() {
  emptyStreak();
  EMPTY_STREAK.count += 1;
  EMPTY_STREAK.at = Date.now();
  return EMPTY_STREAK.count;
}

function resetEmptyStreak() {
  EMPTY_STREAK.count = 0;
  EMPTY_STREAK.at = 0;
}

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

  function takeBudget(live, agent, turn, step) {
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
    if (stepRecord.used >= live.retries) return undefined;

    stepRecord.used += 1;
    turnRecord.used += 1;
    return stepRecord.used;
  }

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

/** 包一层上游流：截断、空响应、思考复读都不许让本轮停在半个状态上。 */
async function* repair(next, options, logger, live, onDegenerate) {
  const { tokenCap, toolFix, autoContinue, continueRounds, emptyResponse, emptyRetries, degenerate } = live;
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
