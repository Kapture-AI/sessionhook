import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeCli, channelServerArguments, supportsChannels } from "./claudeCli.js";
import type { Runner } from "./exec.js";

test("channels need Claude Code 2.1.80 or later", () => {
  assert.equal(supportsChannels("2.1.296 (Claude Code)"), true);
  assert.equal(supportsChannels("2.1.80 (Claude Code)"), true);
  assert.equal(supportsChannels("2.1.79 (Claude Code)"), false);
  assert.equal(supportsChannels("2.0.200"), false);
  assert.equal(supportsChannels("3.0.0"), true);
  assert.equal(supportsChannels("unknown"), false);
});

test("the registration command is user scoped and uses absolute paths", () => {
  assert.deepEqual(channelServerArguments("/usr/bin/node", "/opt/cli.js"), [
    "mcp", "add", "--scope", "user", "sessionhook", "--", "/usr/bin/node", "/opt/cli.js", "channel",
  ]);
});

test("version, hasServer and addServer report what claude answered", async () => {
  const run: Runner = async (_file, args) => {
    if (args[0] === "--version") return { code: 0, stdout: "2.1.296 (Claude Code)\n", stderr: "" };
    if (args[0] === "mcp" && args[1] === "get") return { code: 1, stdout: "", stderr: "" };
    return { code: 2, stdout: "", stderr: "no write access\n" };
  };
  const claude = new ClaudeCli(run);
  assert.equal(await claude.version(), "2.1.296 (Claude Code)");
  assert.equal(await claude.hasServer(), false);
  await assert.rejects(claude.addServer("/n", "/c"), /claude mcp add failed: no write access/);
  const broken = new ClaudeCli(async () => ({ code: 1, stdout: "", stderr: "boom" }));
  await assert.rejects(broken.version(), /claude --version failed: boom/);
});
