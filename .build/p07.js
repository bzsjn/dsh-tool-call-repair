
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
