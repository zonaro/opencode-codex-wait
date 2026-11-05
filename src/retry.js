import { parseCodexHeaders, parseCodexLimit, parseRetryAfter } from "./parser.js";
import { exhaustedQuotaReset, parseQuotaHeaders } from "./quota.js";
import { readCodexStatus } from "./status.js";

export const DEFAULTS = Object.freeze({
  safetyMarginMs: 5_000,
  maxWaitSeconds: 8 * 86_400,
  unknownResetRetrySeconds: 0,
  captureTtlMs: 30_000,
  maxEntries: 100,
  quotaTtlMs: 5 * 60_000,
  statusFallback: "app-server",
  statusTimeoutMs: 5_000,
  statusCooldownMs: 60_000,
});

const MAX_DELAY_MS = 2_147_483_647;
const MAX_BODY_BYTES = 16_384;

function integerOption(value, fallback, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

export function resolveOptions(raw = {}) {
  const options = raw && typeof raw === "object" ? raw : {};
  return {
    safetyMarginMs: integerOption(options.safetyMarginMs, DEFAULTS.safetyMarginMs, 0, 60_000),
    maxWaitSeconds: integerOption(options.maxWaitSeconds, DEFAULTS.maxWaitSeconds, 1, 14 * 86_400),
    unknownResetRetrySeconds: integerOption(options.unknownResetRetrySeconds, DEFAULTS.unknownResetRetrySeconds, 0, 3_600),
    captureTtlMs: integerOption(options.captureTtlMs, DEFAULTS.captureTtlMs, 1_000, 120_000),
    maxEntries: integerOption(options.maxEntries, DEFAULTS.maxEntries, 1, 500),
    quotaTtlMs: integerOption(options.quotaTtlMs, DEFAULTS.quotaTtlMs, 1_000, 60 * 60_000),
    statusFallback: ["app-server", "manual", "off"].includes(options.statusFallback)
      ? options.statusFallback : DEFAULTS.statusFallback,
    statusTimeoutMs: integerOption(options.statusTimeoutMs, DEFAULTS.statusTimeoutMs, 1_000, 15_000),
    statusCooldownMs: integerOption(options.statusCooldownMs, DEFAULTS.statusCooldownMs, 10_000, 60 * 60_000),
  };
}

function keyFor(event) {
  const model = event.model ?? {};
  return JSON.stringify([event.sessionID, model.providerID, model.id, model.variant ?? ""]);
}

function isOpenAI(event) {
  // Codex OAuth models are exposed as provider "openai" in OpenCode.
  return event.model?.providerID === "openai";
}

/** The plugin does not create prompts; only OpenCode's own retry mechanism acts. */
export function createRetryController(rawOptions = {}, now = () => Date.now(), statusReader = readCodexStatus) {
  const options = resolveOptions(rawOptions);
  const captured = new Map();
  const quota = new Map();
  const manualNotified = new Set();
  let statusPending = null;
  let statusLastResult = null;
  let statusLastReadAt = -Infinity;

  function prune() {
    const time = now();
    for (const [key, entry] of captured) {
      if (time - entry.observedAt > options.captureTtlMs) captured.delete(key);
    }
    for (const [key, entry] of quota) {
      if (time - entry.observedAt > options.quotaTtlMs) quota.delete(key);
    }
    while (captured.size > options.maxEntries) captured.delete(captured.keys().next().value);
    while (quota.size > options.maxEntries) quota.delete(quota.keys().next().value);
  }

  async function observeHttpResponse(event) {
    if (!isOpenAI(event) || !event.response) return false;
    const observedAt = now();
    // Passive tracking: reuse every existing model response without extra API calls.
    // Compaction/title calls can also update a shared window, but never trigger retries.
    const windows = parseQuotaHeaders(event.response.headers);
    if (windows.length) {
      prune();
      quota.set(keyFor(event), { observedAt, windows });
      manualNotified.delete(keyFor(event));
      prune();
    }
    if (event.response.status !== 429) return false;
    const header = parseCodexHeaders(event.response.headers, observedAt);
    const retryAfter = parseRetryAfter(event.response.headers?.get("retry-after"), observedAt);

    let body = null;
    const declared = Number(event.response.headers?.get("content-length"));
    if (!(declared > MAX_BODY_BYTES)) {
      try {
        const value = await event.response.clone().text();
        if (Buffer.byteLength(value, "utf8") <= MAX_BODY_BYTES) body = value;
      } catch {
        // Retry hook may still contain the structured provider error.
      }
    }
    const parsed = parseCodexLimit(body, observedAt);
    if (!parsed.recognized && !header.recognized) return false;

    prune();
    const resetAt = Math.max(0, parsed.resetAt ?? 0, header.resetAt ?? 0, retryAfter ?? 0) || null;
    captured.set(keyFor(event), { observedAt, resetAt });
    prune();
    return true;
  }

  function applyRetry(event) {
    if (!isOpenAI(event) || !event.error || (event.error.status != null && Number(event.error.status) !== 429)) return null;
    prune();
    const key = keyFor(event);
    const cached = captured.get(key);
    captured.delete(key);
    const time = now();
    const parsed = parseCodexLimit(event.error.message, time);
    if (!parsed.recognized && !cached) return null;

    const quotaReset = exhaustedQuotaReset(quota.get(key)?.windows, time);

    const resetAt = Math.max(
      0,
      cached?.resetAt ?? 0,
      parsed.resetAt ?? 0,
      quotaReset ?? 0,
    ) || (options.unknownResetRetrySeconds ? time + options.unknownResetRetrySeconds * 1_000 : null);
    if (!resetAt || resetAt <= time) return null;
    const remainingMs = resetAt - time;
    const delay = remainingMs + options.safetyMarginMs;
    if (!Number.isSafeInteger(delay) || delay > MAX_DELAY_MS || remainingMs > options.maxWaitSeconds * 1_000) return null;

    event.decision = { retry: true, delay };
    return {
      delay,
      resetAt,
      source: cached?.resetAt ? "http-response" : parsed.resetAt ? "error-message" : quotaReset ? "quota-headers" : "fallback",
    };
  }

  async function applyRetryWithStatus(event) {
    if (!isOpenAI(event) || !event.error || (event.error.status != null && Number(event.error.status) !== 429)) return null;
    prune();
    const key = keyFor(event);
    const eligible = parseCodexLimit(event.error.message, now()).recognized || captured.has(key);
    const planned = applyRetry(event);
    if (planned || !eligible || options.statusFallback === "off") return planned;

    if (options.statusFallback === "app-server") {
      if (statusPending) await statusPending;
      else if (now() - statusLastReadAt >= options.statusCooldownMs) {
        statusLastReadAt = now();
        statusPending = Promise.resolve()
          .then(() => statusReader({ timeoutMs: options.statusTimeoutMs }))
          .catch(() => null)
          .then((status) => { statusLastResult = status; return status; })
          .finally(() => { statusPending = null; });
        await statusPending;
      }
      // A local CLI may be authenticated to a *different* account. The fallback
      // is explicitly configurable; do not infer availability from a partial window.
      const resetAt = exhaustedQuotaReset(statusLastResult?.limits, now());
      if (resetAt) {
        const remainingMs = resetAt - now();
        const delay = remainingMs + options.safetyMarginMs;
        if (Number.isSafeInteger(delay) && delay <= MAX_DELAY_MS && remainingMs <= options.maxWaitSeconds * 1000) {
          event.decision = { retry: true, delay };
          return { delay, resetAt, source: "codex-app-server" };
        }
      }
    }

    // /status itself is interactive and cannot be run as an unattended API call.
    if (manualNotified.has(key)) return null;
    manualNotified.add(key);
    return { manual: true, source: "manual-status" };
  }

  return {
    observeHttpResponse,
    applyRetry,
    applyRetryWithStatus,
    getObservedQuota: (event) => quota.get(keyFor(event))?.windows ?? [],
    clear: () => { captured.clear(); quota.clear(); manualNotified.clear(); },
  };
}
