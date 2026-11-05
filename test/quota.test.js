import test from "node:test";
import assert from "node:assert/strict";
import { exhaustedQuotaReset, parseAppServerQuota, parseQuotaHeaders } from "../src/quota.js";

const NOW = 1_793_000_000_000;

test("reads both 5-hour and weekly quotas from successful HTTP headers", () => {
  const limits = parseQuotaHeaders(new Headers({
    "x-codex-primary-used-percent": "82.5",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1793003600",
    "x-codex-secondary-used-percent": "44",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "1793100000",
  }));
  assert.deepEqual(limits, [{ limitId: "codex", windows: [
    { kind: "primary", usedPercent: 82.5, windowDurationMins: 300, resetsAt: NOW + 3_600_000 },
    { kind: "secondary", usedPercent: 44, windowDurationMins: 10080, resetsAt: 1_793_100_000_000 },
  ] }]);
  assert.equal(exhaustedQuotaReset(limits, NOW), null);
});

test("recognizes independent metered families and only exhausted windows", () => {
  const limits = parseQuotaHeaders(new Headers({
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1793003600",
    "x-codex-secondary-used-percent": "100",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "1793100000",
    "x-codex-other-primary-used-percent": "66",
    "x-codex-other-primary-window-minutes": "60",
    "x-codex-other-primary-reset-at": "1793001000",
  }));
  assert.equal(limits.length, 2);
  assert.equal(limits[1].limitId, "codex_other");
  assert.equal(exhaustedQuotaReset(limits, NOW), 1_793_100_000_000);
});

test("rejects incomplete, malformed and irrelevant headers", () => {
  assert.deepEqual(parseQuotaHeaders(new Headers({ "x-ratelimit-limit-requests": "5" })), []);
  assert.deepEqual(parseQuotaHeaders(new Headers({
    "x-codex-primary-used-percent": "NaN",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1793001000",
  })), []);
  assert.deepEqual(parseQuotaHeaders(null), []);
});

test("normalizes app-server snapshots and ignores a missing or expired reset", () => {
  const limits = parseAppServerQuota({ rateLimits: {
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_793_004_000 },
    secondary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1_793_100_000 },
  } });
  assert.equal(exhaustedQuotaReset(limits, NOW), NOW + 4_000_000);
  assert.equal(exhaustedQuotaReset(limits, NOW + 5_000_000), null);
  assert.deepEqual(parseAppServerQuota({ rateLimitsByLimitId: { other: { primary: { usedPercent: 100 } } } }), []);
});
