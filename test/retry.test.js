import test from "node:test";
import assert from "node:assert/strict";
import { createRetryController, resolveOptions } from "../src/retry.js";
import { setupCodexWait } from "../src/server.js";

const NOW = 1_793_000_000_000;
const model = { providerID: "openai", id: "gpt-6.1-sol" };
const error = { type: "provider.rate-limit", status: 429, message: JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 300 } }) };

function retryEvent(overrides = {}) {
  return {
    sessionID: "session-1",
    agent: "build",
    model,
    attempt: 2,
    error,
    decision: { retry: false },
    ...overrides,
  };
}

function responseEvent(body, headers = {}) {
  return {
    sessionID: "session-1",
    agent: "build",
    model,
    response: new Response(JSON.stringify(body), { status: 429, headers }),
  };
}

test("uses the retry hook to schedule the same request without creating a prompt", () => {
  const controller = createRetryController({}, () => NOW);
  const event = retryEvent();
  assert.deepEqual(controller.applyRetry(event), {
    delay: 305_000,
    resetAt: NOW + 300_000,
    source: "error-message",
  });
  assert.deepEqual(event.decision, { retry: true, delay: 305_000 });
});

test("subtracts elapsed time captured at the HTTP response", async () => {
  let time = NOW;
  const controller = createRetryController({}, () => time);
  const body = { error: { type: "usage_limit_reached", resets_in_seconds: 300 } };
  assert.equal(await controller.observeHttpResponse(responseEvent(body)), true);
  time += 2_000;
  const event = retryEvent({ error: { status: 429, message: "rate-limited" } });
  const planned = controller.applyRetry(event);
  assert.deepEqual(planned, { delay: 303_000, resetAt: NOW + 300_000, source: "http-response" });
});

test("uses Retry-After when the response identifies an OAuth usage limit", async () => {
  const controller = createRetryController({}, () => NOW);
  const response = responseEvent({ error: { code: "subscription_sharing_usage_limit_exceeded" } }, { "retry-after": "420" });
  assert.equal(await controller.observeHttpResponse(response), true);
  const event = retryEvent({ error: { status: 429, message: "HTTP 429" } });
  assert.equal(controller.applyRetry(event).delay, 425_000);
});

test("ignores a subscription limit without explicit reset by default", async () => {
  const controller = createRetryController({}, () => NOW);
  const event = retryEvent({ error: { status: 429, message: "subscription_sharing_usage_limit_exceeded" } });
  assert.equal(controller.applyRetry(event), null);
  assert.deepEqual(event.decision, { retry: false });
});

test("optional bounded fallback can wait when no reset was supplied", () => {
  const controller = createRetryController({ unknownResetRetrySeconds: 600 }, () => NOW);
  const event = retryEvent({ error: { status: 429, message: "subscription_sharing_usage_limit_exceeded" } });
  assert.equal(controller.applyRetry(event).delay, 605_000);
});

test("never modifies other providers or unrelated OpenAI errors", async () => {
  const controller = createRetryController({}, () => NOW);
  const original = { retry: false };
  for (const input of [
    retryEvent({ model: { providerID: "claudinio", id: "claude" } }),
    retryEvent({ error: { status: 429, message: "generic rate_limit_exceeded" } }),
    retryEvent({ error: { status: 401, message: "usage_limit_reached" } }),
    retryEvent({ error: { status: 402, message: "usage_limit_reached" } }),
  ]) {
    assert.equal(controller.applyRetry(input), null);
    assert.deepEqual(input.decision, original);
  }
  assert.equal(await controller.observeHttpResponse({ ...responseEvent({ error: { type: "usage_limit_reached", resets_in_seconds: 50 } }), model: { providerID: "anthropic", id: "claude" } }), false);
});

test("enforces wait caps and validates configuration", () => {
  const controller = createRetryController({ maxWaitSeconds: 60 }, () => NOW);
  assert.equal(controller.applyRetry(retryEvent()), null);
  assert.equal(resolveOptions({ maxWaitSeconds: -3 }).maxWaitSeconds, 691_200);
  assert.equal(resolveOptions({ safetyMarginMs: 100_000 }).safetyMarginMs, 5_000);
});

test("expired HTTP observations cannot affect a later unrelated 429", async () => {
  let time = NOW;
  const controller = createRetryController({ captureTtlMs: 1_000 }, () => time);
  await controller.observeHttpResponse(responseEvent({ error: { type: "usage_limit_reached", resets_in_seconds: 300 } }));
  time += 2_000;
  assert.equal(controller.applyRetry(retryEvent({ error: { status: 429, message: "unknown error" } })), null);
});

test("registers both hooks and disposes them cleanly", async () => {
  const hooks = new Map();
  const disposed = [];
  const cleanup = await setupCodexWait({
    options: {},
    session: {
      async hook(name, callback) {
        hooks.set(name, callback);
        return { async dispose() { disposed.push(name); } };
      },
    },
  });
  assert.deepEqual([...hooks.keys()], ["http.response", "retry"]);
  await cleanup();
  assert.deepEqual(disposed.sort(), ["http.response", "retry"]);
});
