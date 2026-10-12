import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSubscriberName, resolveSubscriberName } from "./subscriber.js";

test("the flag wins, then SESSIONHOOK_SUBSCRIBER, then CLAUDE_CODE_SESSION_ID", () => {
  const env = { SESSIONHOOK_SUBSCRIBER: "from-env", CLAUDE_CODE_SESSION_ID: "from-session" };
  assert.equal(resolveSubscriberName("from-flag", env), "from-flag");
  assert.equal(resolveSubscriberName(undefined, env), "from-env");
  assert.equal(resolveSubscriberName(undefined, { CLAUDE_CODE_SESSION_ID: "from-session" }), "from-session");
});

test("without any source the error says how to pass a name", () => {
  assert.throws(() => resolveSubscriberName(undefined, {}), /pass --name <name> or set SESSIONHOOK_SUBSCRIBER/);
});

test("names with spaces, control characters or too many characters are rejected", () => {
  assert.equal(checkSubscriberName("9b1c-4f.session_1:a@b"), "9b1c-4f.session_1:a@b");
  for (const name of ["", "has space", "line\nbreak", "x".repeat(129)]) {
    assert.throws(() => checkSubscriberName(name), /invalid subscriber name/);
  }
});
