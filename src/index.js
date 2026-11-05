import { Plugin } from "@opencode/plugin";
import { setupCodexWait } from "./server.js";

export default Plugin.define({
  id: "opencode-codex-wait",
  setup: setupCodexWait,
});
