/**
 * Only recognize Codex/ChatGPT-plan usage-limit signatures. An HTTP 429 on
 * its own is not proof of a recoverable subscription limit.
 */
const LIMIT_CODES = new Set([
  "usage_limit_reached",
  "subscription_sharing_usage_limit_exceeded",
]);
const LIMIT_MARKER = /\b(?:usage_limit_reached|subscription_sharing_usage_limit_exceeded)\b/i;
const MAX_MESSAGE_LENGTH = 16_384;

function finitePositiveInteger(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function absoluteReset(value) {
  const seconds = finitePositiveInteger(value);
  // Codex reset timestamps are Unix seconds, not milliseconds.
  return seconds && seconds < 100_000_000_000 ? seconds * 1_000 : null;
}

function relativeReset(value, observedAt) {
  const seconds = finitePositiveInteger(value);
  return seconds && seconds <= Number.MAX_SAFE_INTEGER / 1_000
    ? observedAt + seconds * 1_000
    : null;
}

function latestFuture(now, ...times) {
  const valid = times.filter((time) => Number.isSafeInteger(time) && time > now);
  return valid.length ? Math.max(...valid) : null;
}

/**
 * Returns { recognized, resetAt }. Handles JSON response bodies, errors
 * nested in SDK wrappers and stringified error messages.
 */
export function parseCodexLimit(value, observedAt = Date.now()) {
  let recognized = false;
  const times = [];
  const seen = new Set();

  function scan(candidate, depth = 0) {
    if (depth > 5 || candidate == null) return;
    if (typeof candidate === "string") {
      if (candidate.length > MAX_MESSAGE_LENGTH) return;
      try {
        scan(JSON.parse(candidate), depth + 1);
      } catch {
        // OpenCode may wrap serialized JSON in a human-readable message.
        if (!LIMIT_MARKER.test(candidate)) return;
        recognized = true;
        const at = candidate.match(/["']?resets_at["']?\s*[:=]\s*(\d+)/i);
        const seconds = candidate.match(/["']?resets_in_seconds["']?\s*[:=]\s*(\d+)/i);
        const when = absoluteReset(at?.[1]);
        const after = relativeReset(seconds?.[1], observedAt);
        if (when) times.push(when);
        if (after) times.push(after);
      }
      return;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);

    const code = candidate.code;
    const type = candidate.type;
    const isLimit = LIMIT_CODES.has(code) || LIMIT_CODES.has(type);
    if (isLimit) {
      recognized = true;
      const when = absoluteReset(candidate.resets_at ?? candidate.resetsAt);
      const after = relativeReset(candidate.resets_in_seconds ?? candidate.resetsInSeconds, observedAt);
      if (when) times.push(when);
      if (after) times.push(after);
    }
    // Known error-wrapper keys only: do not scan arbitrary user/model content.
    scan(candidate.error, depth + 1);
    scan(candidate.cause, depth + 1);
    scan(candidate.message, depth + 1);
    scan(candidate.response?.error, depth + 1);
  }

  scan(value);
  return { recognized, resetAt: recognized ? latestFuture(observedAt, ...times) : null };
}

export function parseRetryAfter(value, observedAt = Date.now()) {
  if (typeof value !== "string" || value.length > 128) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return relativeReset(trimmed, observedAt);
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) && timestamp > observedAt ? timestamp : null;
}

/**
 * Some Codex responses contain x-codex-* quota windows. Only use a reset
 * window when its usage is explicitly exhausted, or the server identifies the
 * active quota family and a matching reset exists.
 */
export function parseCodexHeaders(headers, observedAt = Date.now()) {
  if (!headers || typeof headers.get !== "function") return { recognized: false, resetAt: null };
  const active = headers.get("x-codex-active-limit");
  const activeSuffix = typeof active === "string" && /^codex(?:_[a-z0-9_-]+)?$/i.test(active)
    ? active.replace(/^codex_?/i, "").replaceAll("_", "-")
    : null;
  const prefix = activeSuffix === null || activeSuffix === "" ? "x-codex-" : `x-codex-${activeSuffix}-`;
  const families = new Set(["x-codex-"]);
  if (activeSuffix !== null) families.add(prefix);

  let recognized = activeSuffix !== null;
  const times = [];
  for (const family of families) {
    for (const window of ["primary", "secondary"]) {
      const used = Number(headers.get(`${family}${window}-used-percent`));
      const reset = absoluteReset(headers.get(`${family}${window}-reset-at`));
      if (reset && Number.isFinite(used) && used >= 100) {
        recognized = true;
        times.push(reset);
      } else if (reset && activeSuffix !== null && family === prefix) {
        // The response identifies this exact quota family as active.
        times.push(reset);
      }
    }
  }
  return { recognized, resetAt: latestFuture(observedAt, ...times) };
}
