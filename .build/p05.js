
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

  // 定向供应商：只有 id 命中白名单的请求才走补偿逻辑，其余原样放行。
  const scopedRaw = raw['定向供应商'] ?? raw.scopedProviders;
  const scopedProviders = Array.isArray(scopedRaw)
    ? scopedRaw.map((item) => String(item).trim()).filter((item) => item.length > 0)
    : [...DEFAULTS.scopedProviders];
  const scopedMaxTokens = Math.floor(
    positive(raw['定向输出上限'] ?? raw.scopedMaxTokens, DEFAULTS.scopedMaxTokens),
  );
  const scopedRetries = Math.floor(
    positive(raw['定向重试次数'] ?? raw.scopedRetries, DEFAULTS.scopedRetries),
  );
  const scopedEmptyRetries = Math.floor(
    positive(raw['定向空响应次数'] ?? raw.scopedEmptyRetries, DEFAULTS.scopedEmptyRetries),
  );

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
    scoped: new Set(scopedProviders),
    scopedMaxTokens,
    scopedRetries,
    scopedEmptyRetries,
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
