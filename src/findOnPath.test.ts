import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findOnPath } from "./findOnPath.js";

const root = mkdtempSync(join(tmpdir(), "sessionhook-path-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("the first runnable file with that name on the path is returned, and nothing else counts", () => {
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "tool"), "#!/bin/sh\n", { mode: 0o644 });
  writeFileSync(join(second, "tool"), "#!/bin/sh\n");
  chmodSync(join(second, "tool"), 0o755);
  mkdirSync(join(first, "folder"));
  assert.equal(findOnPath("tool", [first, second].join(delimiter)), join(second, "tool"));
  assert.equal(findOnPath("folder", first), undefined);
  assert.equal(findOnPath("absent", [first, second].join(delimiter)), undefined);
  assert.equal(findOnPath("tool", undefined), undefined);
  assert.equal(findOnPath("tool", ""), undefined);
});
