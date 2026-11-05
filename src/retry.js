import { parseCodexHeaders, parseCodexLimit, parseRetryAfter } from "./parser.js";

export const DEFAULTS = Object.freeze({
  safetyMarginMs: 5_000,
  maxWaitSeconds: 8 * 86_400,
  unknownResetRetrySeconds: 0,
  captureTtlMs: 30_000,
  maxEntries: 100,
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
export function createRetryController(rawOptions = {}, now = () => Date.now()) {
  const options = resolveOptions(rawOptions);
  const captured = new Map();

  function prune() {
    const time = now();
    for (const [key, entry] of captured) {
      if (time - entry.observedAt > options.captureTtlMs) captured.delete(key);
    }
    while (captured.size > options.maxEntries) captured.delete(captured.keys().next().value);
  }

  async function observeHttpResponse(event) {
    if (!isOpenAI(event) || event.response?.status !== 429) return false;
    const observedAt = now();
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

    const resetAt = Math.max(
      0,
      cached?.resetAt ?? 0,
      parsed.resetAt ?? 0,
    ) || (options.unknownResetRetrySeconds ? time + options.unknownResetRetrySeconds * 1_000 : null);
    if (!resetAt || resetAt <= time) return null;
    const remainingMs = resetAt - time;
    const delay = remainingMs + options.safetyMarginMs;
    if (!Number.isSafeInteger(delay) || delay > MAX_DELAY_MS || remainingMs > options.maxWaitSeconds * 1_000) return null;

    event.decision = { retry: true, delay };
    return {
      delay,
      resetAt,
      source: cached?.resetAt ? "http-response" : parsed.resetAt ? "error-message" : "fallback",
    };
  }

  return { observeHttpResponse, applyRetry, clear: () => captured.clear() };
}
