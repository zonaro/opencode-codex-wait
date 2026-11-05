import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexHeaders, parseCodexLimit, parseRetryAfter } from "../src/parser.js";

const NOW = 1_793_000_000_000;

test("recognizes Codex usage-limit JSON with explicit reset timestamp", () => {
  const result = parseCodexLimit({ error: { type: "usage_limit_reached", resets_at: 1_793_004_000 } }, NOW);
  assert.deepEqual(result, { recognized: true, resetAt: 1_793_004_000_000 });
});

test("recognizes seconds remaining in a serialized provider error", () => {
  const message = JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 3126 } });
  assert.deepEqual(parseCodexLimit(message, NOW), { recognized: true, resetAt: NOW + 3_126_000 });
});

test("recognizes the ChatGPT subscription code without making up a reset time", () => {
  assert.deepEqual(
    parseCodexLimit({ error: { code: "subscription_sharing_usage_limit_exceeded" } }, NOW),
    { recognized: true, resetAt: null },
  );
});

test("reads recognized structured errors inside human-readable SDK wrappers", () => {
  const wrapper = 'Provider failed: {"error":{"type":"usage_limit_reached","resets_in_seconds":120}}';
  assert.deepEqual(parseCodexLimit(wrapper, NOW), { recognized: true, resetAt: NOW + 120_000 });
});

test("rejects generic rate-limits, billing errors and arbitrary numeric fields", () => {
  for (const value of [
    { error: { code: "rate_limit_exceeded", resets_in_seconds: 300 } },
    { error: { code: "insufficient_quota", resets_at: 1_793_004_000 } },
    { error: { message: "429 Too Many Requests", resets_in_seconds: 300 } },
  ]) {
    assert.deepEqual(parseCodexLimit(value, NOW), { recognized: false, resetAt: null });
  }
});

test("ignores invalid, stale and oversized reset numbers", () => {
  assert.equal(parseCodexLimit({ error: { type: "usage_limit_reached", resets_at: 1_700_000_000 } }, NOW).resetAt, null);
  assert.equal(parseCodexLimit({ error: { type: "usage_limit_reached", resets_in_seconds: -10 } }, NOW).resetAt, null);
  assert.equal(parseCodexLimit({ error: { type: "usage_limit_reached", resets_at: "100000000000000000000" } }, NOW).resetAt, null);
});

test("reads Retry-After seconds or HTTP-date", () => {
  assert.equal(parseRetryAfter("56", NOW), NOW + 56_000);
  assert.equal(parseRetryAfter(new Date(NOW + 120_000).toUTCString(), NOW), NOW + 120_000);
  assert.equal(parseRetryAfter("invalid", NOW), null);
  assert.equal(parseRetryAfter("0", NOW), null);
});

test("reads an exhausted primary Codex window", () => {
  const headers = new Headers({
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-reset-at": "1793004000",
  });
  assert.deepEqual(parseCodexHeaders(headers, NOW), { recognized: true, resetAt: NOW + 4_000_000 });
});

test("uses the active named Codex limit family", () => {
  const headers = new Headers({
    "x-codex-active-limit": "codex_other",
    "x-codex-other-primary-used-percent": "100",
    "x-codex-other-primary-reset-at": "1793002000",
  });
  assert.deepEqual(parseCodexHeaders(headers, NOW), { recognized: true, resetAt: NOW + 2_000_000 });
});

test("does not infer exhaustion from a partially used generic window", () => {
  const headers = new Headers({
    "x-codex-primary-used-percent": "45",
    "x-codex-primary-reset-at": "1793004000",
  });
  assert.deepEqual(parseCodexHeaders(headers, NOW), { recognized: false, resetAt: null });
});
