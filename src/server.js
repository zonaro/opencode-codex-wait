import { createRetryController } from "./retry.js";

/** OpenCode 2.x server adapter. All parsing and scheduling can be tested offline. */
export async function setupCodexWait(ctx) {
  const controller = createRetryController(ctx.options);
  const responseHook = await ctx.session.hook("http.response", (event) =>
    controller.observeHttpResponse(event),
  );
  const retryHook = await ctx.session.hook("retry", async (event) => {
    const planned = await controller.applyRetryWithStatus(event);
    if (!planned) return;
    if (planned.manual) {
      console.info("[opencode-codex-wait] Reset desconhecido; abra o Codex CLI e use /status para conferir as janelas. Nenhuma tentativa foi agendada.");
      return;
    }
    // Never print headers, response bodies, auth state, tokens or raw errors.
    console.info(
      `[opencode-codex-wait] Session ${event.sessionID}: retry #${event.attempt} in ${Math.ceil(planned.delay / 1_000)}s (${planned.source}).`,
    );
  });

  return async () => {
    controller.clear();
    await Promise.all([responseHook.dispose(), retryHook.dispose()]);
  };
}
