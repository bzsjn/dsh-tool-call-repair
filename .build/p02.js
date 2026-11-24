
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
  // —— 按供应商定向补偿。默认只含中转站里那个输出被硬顶的端点，
  // 判定用 `options.provider`，不碰任何全局配置。
  scopedProviders: ['daapsaak'],
  scopedMaxTokens: 32768,
  scopedRetries: 8,
  scopedEmptyRetries: 5,
};
