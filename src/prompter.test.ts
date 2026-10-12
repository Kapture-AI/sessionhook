import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { TerminalPrompter } from "./prompter.js";

function setUp(terminal: boolean) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk: Buffer) => (shown += chunk.toString()));
  return { input, prompter: new TerminalPrompter(input, output, terminal), shown: () => shown };
}

test("answers that arrive together are each given to the question that follows", async () => {
  const { input, prompter } = setUp(false);
  input.write("first\n\nyes\n");
  assert.equal(await prompter.ask("One"), "first");
  assert.equal(await prompter.ask("Two", "kept"), "kept");
  assert.equal(await prompter.confirm("Three", false), true);
  prompter.close();
});

test("confirm returns its fallback for an empty answer and asks again for an unclear one", async () => {
  const { input, prompter, shown } = setUp(false);
  input.write("\nmaybe\nn\n");
  assert.equal(await prompter.confirm("Sure", true), true);
  assert.equal(await prompter.confirm("Really", true), false);
  assert.match(shown(), /Sure \[Y\/n\]: /);
  prompter.close();
});

test("a secret typed at a terminal is not echoed", async () => {
  const { input, prompter, shown } = setUp(true);
  const pending = prompter.secret("Token");
  input.write("fake-typed-secret\n");
  assert.equal(await pending, "fake-typed-secret");
  assert.match(shown(), /Token: /);
  assert.ok(!shown().includes("fake-typed-secret"));
  prompter.close();
});

test("a question that is asked after the input ended fails with a clear message", async () => {
  const { input, prompter } = setUp(false);
  input.end();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(prompter.ask("One"), /the input ended before every question was answered/);
  prompter.close();
});

test("a question waiting when the input ends fails with a clear message", async () => {
  const { input, prompter } = setUp(false);
  const pending = prompter.ask("One");
  input.end();
  await assert.rejects(pending, /the input ended/);
  prompter.close();
});
