import { spawn } from "node:child_process";
import { parseAppServerQuota } from "./quota.js";

const MAX_STDOUT_BYTES = 512 * 1024;

/**
 * /status is an interactive Codex CLI command. The supported noninteractive
 * equivalent is the app-server's account/rateLimits/read RPC. This starts a
 * separate, already-authenticated Codex CLI and never reads or copies tokens.
 */
export async function readCodexStatus({ spawnImpl = spawn, command = "codex", timeoutMs = 5_000 } = {}) {
  return new Promise((resolve) => {
    let process;
    let timer;
    let finished = false;
    let buffer = "";
    let totalBytes = 0;

    const finish = (result = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { process?.kill(); } catch { /* Already exited. */ }
      resolve(result);
    };

    function send(message) {
      try { process.stdin.write(`${JSON.stringify(message)}\n`); } catch { finish(); }
    }

    function receive(line) {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message?.id === 1) {
        if (message.error || !message.result) return finish();
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
      } else if (message?.id === 2) {
        if (message.error || !message.result) return finish();
        const limits = parseAppServerQuota(message.result);
        finish(limits.length ? { limits, ordinaryUsageAllowed: message.result.ordinaryUsageAllowed ?? null } : null);
      }
    }

    try {
      process = spawnImpl(command, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "ignore"],
        shell: false,
      });
    } catch { return finish(); }

    timer = setTimeout(() => finish(), timeoutMs);
    timer.unref?.();
    process.on("error", () => finish());
    process.on("close", () => finish());
    process.stdin.on("error", () => finish());
    process.stdout.on("error", () => finish());
    process.stdout.on("data", (chunk) => {
      if (finished) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_STDOUT_BYTES) return finish();
      buffer += chunk.toString("utf8");
      let newline;
      while (!finished && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) receive(line);
      }
    });
    send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "opencode-codex-wait", title: "OpenCode Codex Wait", version: "0.2.0" },
      capabilities: {},
    } });
  });
}
