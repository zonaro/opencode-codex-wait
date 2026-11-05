import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readCodexStatus } from "../src/status.js";

test("reads quota via Codex app-server RPC without requesting inference", async () => {
  const sent = [];
  let spawned = null;
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => true;
  child.stdin.on("data", (chunk) => {
    const message = JSON.parse(chunk.toString().trim());
    sent.push(message);
    if (message.id === 1) child.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "Codex" } })}\n`);
    if (message.id === 2) child.stdout.write(`${JSON.stringify({ id: 2, result: {
      ordinaryUsageAllowed: false,
      rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_793_004_000 } },
    } })}\n`);
  });
  const result = await readCodexStatus({
    spawnImpl: (...args) => { spawned = args; return child; },
    timeoutMs: 2_000,
  });
  assert.deepEqual(spawned.slice(0, 2), ["codex", ["app-server", "--listen", "stdio://"]]);
  assert.deepEqual(sent.map((entry) => entry.method), ["initialize", "initialized", "account/rateLimits/read"]);
  assert.equal(result.ordinaryUsageAllowed, false);
  assert.equal(result.limits[0].windows[0].windowDurationMins, 300);
});

test("missing CLI or unauthenticated app-server returns no quota", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => true;
  child.stdin.on("data", (chunk) => {
    const message = JSON.parse(chunk.toString().trim());
    if (message.id === 1) child.stdout.write('{"id":1,"result":{}}\n');
    if (message.id === 2) child.stdout.write('{"id":2,"error":{"message":"auth required"}}\n');
  });
  assert.equal(await readCodexStatus({ spawnImpl: () => child }), null);
  assert.equal(await readCodexStatus({ spawnImpl: () => { throw new Error("ENOENT"); } }), null);
});
