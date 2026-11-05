/** Codex subscription windows observed in HTTP headers or app-server status. */
const MAX_WINDOW_MINUTES = 366 * 24 * 60;

function percentage(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function minutes(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= MAX_WINDOW_MINUTES ? number : null;
}

function unixMilliseconds(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number < 100_000_000_000 ? number * 1000 : null;
}

function makeWindow(kind, percent, duration, reset) {
  const usedPercent = percentage(percent);
  const windowDurationMins = minutes(duration);
  const resetsAt = unixMilliseconds(reset);
  if (usedPercent === null || (windowDurationMins === null && resetsAt === null)) return null;
  return { kind, usedPercent, windowDurationMins, resetsAt };
}

/** Keeps the metered limit ID separate from the primary/secondary window name. */
export function parseQuotaHeaders(headers) {
  if (!headers || typeof headers.get !== "function" || typeof headers.keys !== "function") return [];
  const families = new Set(["codex"]);
  for (const rawName of headers.keys()) {
    const name = String(rawName).toLowerCase();
    const match = /^x-(codex(?:-[a-z0-9-]+)?)-(?:primary|secondary)-(?:used-percent|window-minutes|reset-at)$/.exec(name);
    if (match) families.add(match[1]);
  }

  const limits = [];
  for (const family of families) {
    const windows = [];
    for (const kind of ["primary", "secondary"]) {
      const prefix = `x-${family}-${kind}-`;
      const window = makeWindow(
        kind,
        headers.get(`${prefix}used-percent`),
        headers.get(`${prefix}window-minutes`),
        headers.get(`${prefix}reset-at`),
      );
      if (window) windows.push(window);
    }
    if (windows.length) limits.push({ limitId: family.replaceAll("-", "_"), windows });
  }
  return limits;
}

/** Accepts the app-server's camelCase rate-limit response without exposing account metadata. */
export function parseAppServerQuota(result) {
  if (!result || typeof result !== "object") return [];
  const buckets = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === "object"
    ? Object.entries(result.rateLimitsByLimitId)
    : [["codex", result.rateLimits]];
  return buckets.flatMap(([limitId, bucket]) => {
    if (!bucket || typeof bucket !== "object" || !/^codex(?:_[a-z0-9_-]+)?$/i.test(limitId)) return [];
    const windows = [];
    for (const kind of ["primary", "secondary"]) {
      const raw = bucket[kind];
      if (!raw || typeof raw !== "object") continue;
      const window = makeWindow(kind, raw.usedPercent, raw.windowDurationMins, raw.resetsAt);
      if (window) windows.push(window);
    }
    return windows.length ? [{ limitId, windows }] : [];
  });
}

/** Never infer a reset from a partial window or an expired timestamp. */
export function exhaustedQuotaReset(limits, observedAt = Date.now()) {
  const resets = [];
  for (const limit of limits ?? []) {
    for (const window of limit.windows ?? []) {
      if (window.usedPercent >= 100 && Number.isSafeInteger(window.resetsAt) && window.resetsAt > observedAt) {
        resets.push(window.resetsAt);
      }
    }
  }
  return resets.length ? Math.max(...resets) : null;
}
