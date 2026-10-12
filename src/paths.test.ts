import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStateDir, resolvePaths } from "./paths.js";

test("the environment overrides both directories", () => {
  const paths = resolvePaths({ SESSIONHOOK_CONFIG_DIR: "/c", SESSIONHOOK_STATE_DIR: "/s" });
  assert.equal(paths.configFile, "/c/config.json");
  assert.equal(paths.secretsFile, "/c/secrets.json");
  assert.equal(paths.databaseFile, "/s/events.db");
  assert.equal(paths.socketFile, "/s/broker.sock");
});

test("without overrides the directories sit under the home directory", () => {
  const paths = resolvePaths({});
  assert.match(paths.configDir, /\.config\/sessionhook$/);
  assert.match(paths.stateDir, /\.local\/state\/sessionhook$/);
});

test("a state directory the broker creates is private", () => {
  const base = mkdtempSync(join(tmpdir(), "sessionhook-paths-"));
  try {
    const paths = resolvePaths({ SESSIONHOOK_STATE_DIR: join(base, "state") });
    ensureStateDir(paths);
    assert.equal(statSync(paths.stateDir).mode & 0o777, 0o700);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
