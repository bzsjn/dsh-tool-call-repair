
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
