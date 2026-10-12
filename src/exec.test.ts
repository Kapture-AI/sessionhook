import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandNotFoundError, runCommand } from "./exec.js";

test("runCommand returns the output of a program that succeeds", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);
  assert.deepEqual(result, { code: 0, stdout: "out", stderr: "err" });
});

test("runCommand returns a non-zero exit code instead of throwing", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.exit(3)"]);
  assert.equal(result.code, 3);
});

test("runCommand rejects with the program name when it does not exist", async () => {
  await assert.rejects(runCommand("sessionhook-no-such-program", []), (error: unknown) => {
    assert.ok(error instanceof CommandNotFoundError);
    assert.equal(error.file, "sessionhook-no-such-program");
    return true;
  });
});
