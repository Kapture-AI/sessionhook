import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerNotRunningError } from "./client.js";
import type { SpawnConfig } from "./config.js";
import type { RunResult, Runner } from "./exec.js";
import { Spawner, defaultSessionName, type SpawnRequest } from "./spawn.js";

const cwd = mkdtempSync(join(tmpdir(), "sessionhook-spawn-"));
after(() => rmSync(cwd, { recursive: true, force: true }));

const dialog = "WARNING: Loading development channels\n 1. I am using this for local development\n";

type Setup = {
  config?: SpawnConfig;
  env?: NodeJS.ProcessEnv;
  sessionExists?: boolean;
  // Successive screens captured from the pane, the last one repeats. A string "ended" fails the capture.
  screens?: Array<string | "ended">;
  located?: Record<string, string | undefined>;
  subscribeFails?: boolean;
};

function setUp(setup: Setup = {}) {
  const calls: string[][] = [];
  const events: string[] = [];
  const output: string[] = [];
  const screens = [...(setup.screens ?? [dialog, "running\n"])];
  const run: Runner = async (file, args) => {
    calls.push([file, ...args]);
    const result: RunResult = { code: 0, stdout: "", stderr: "" };
    if (args[0] === "has-session") return { ...result, code: setup.sessionExists ? 0 : 1 };
    if (args[0] === "new-session") events.push("new-session");
    if (args[0] === "capture-pane") {
      const screen = screens.length > 1 ? screens.shift()! : screens[0]!;
      return screen === "ended" ? { ...result, code: 1 } : { ...result, stdout: screen };
    }
    return result;
  };
  const spawner = new Spawner({
    config: setup.config ?? { claudeFlags: [] },
    env: setup.env ?? {},
    client: {
      subscribe: async (name, topic) => {
        if (setup.subscribeFails) throw new BrokerNotRunningError();
        events.push(`subscribe ${name} ${topic}`);
      },
    },
    run,
    locate: (program) => (setup.located && program in setup.located ? setup.located[program] : `/usr/bin/${program}`),
    sleep: async () => {},
    out: (line) => output.push(line),
  });
  const start = (request: Partial<SpawnRequest> = {}) => spawner.start({ topic: "jira:PROJ-123", cwd, confirmDialog: true, ...request });
  return { start, calls, events, output };
}

function newSession(calls: string[][]): string[] {
  const call = calls.find((c) => c[1] === "new-session");
  assert.ok(call, "no new-session call");
  return call;
}

test("the session name comes from the key of the topic", () => {
  assert.equal(defaultSessionName("jira:PROJ-123"), "proj-123");
  assert.equal(defaultSessionName("deploys:acme/web"), "acme-web");
  assert.equal(defaultSessionName("jira:/odd key/"), "odd-key");
  assert.throws(() => defaultSessionName("jira:///"), /cannot derive a session name/);
});

test("spawn subscribes first, then starts a detached session with exactly these arguments", async () => {
  const { start, calls, events } = setUp();
  await start({ prompt: "Say ready." });
  assert.deepEqual(events, ["subscribe proj-123 jira:PROJ-123", "new-session"]);
  assert.deepEqual(newSession(calls), [
    "/usr/bin/tmux", "new-session", "-d", "-s", "proj-123", "-c", cwd,
    "-e", "SESSIONHOOK_SUBSCRIBER=proj-123",
    "/usr/bin/claude 'Say ready.' --dangerously-load-development-channels server:sessionhook",
  ]);
});

test("the claude flags of the config are passed as they are, after the prompt and before the channel flag", async () => {
  const { start, calls } = setUp({ config: { claudeFlags: ["--model", "some-model", "--name", "two words"] } });
  await start({ prompt: "it's a prompt" });
  assert.equal(
    newSession(calls).at(-1),
    "/usr/bin/claude 'it'\\''s a prompt' --model some-model --name 'two words' --dangerously-load-development-channels server:sessionhook",
  );
});

test("no permission flag is added unless the user put it in the config", async () => {
  const plain = setUp({ config: { claudeFlags: ["--model", "some-model"] } });
  await plain.start({});
  const everything = plain.calls.flat().join(" ");
  assert.ok(!everything.includes("skip-permissions"));
  assert.ok(!everything.includes("permission"));

  const chosen = setUp({ config: { claudeFlags: ["--dangerously-skip-permissions"] } });
  await chosen.start({});
  assert.match(newSession(chosen.calls).at(-1)!, /--dangerously-skip-permissions --dangerously-load-development-channels/);
});

test("the prompt is the option, then the config, then a default that names the topic", async () => {
  const fromConfig = setUp({ config: { claudeFlags: [], prompt: "From config." } });
  await fromConfig.start({});
  assert.match(newSession(fromConfig.calls).at(-1)!, /^\/usr\/bin\/claude 'From config\.' /);
  const override = setUp({ config: { claudeFlags: [], prompt: "From config." } });
  await override.start({ prompt: "From option." });
  assert.match(newSession(override.calls).at(-1)!, /^\/usr\/bin\/claude 'From option\.' /);
  const fallback = setUp();
  await fallback.start({});
  assert.match(newSession(fallback.calls).at(-1)!, /subscribed to jira:PROJ-123 through the sessionhook channel/);
});

test("--name sets both the tmux session and the subscriber, and the location variables are passed through", async () => {
  const { start, calls, events } = setUp({ env: { SESSIONHOOK_STATE_DIR: "/data/state", SESSIONHOOK_CONFIG_DIR: "/data/config", HOME: "/h" } });
  await start({ name: "sh_test-1" });
  assert.deepEqual(events[0], "subscribe sh_test-1 jira:PROJ-123");
  assert.deepEqual(newSession(calls).slice(0, -1), [
    "/usr/bin/tmux", "new-session", "-d", "-s", "sh_test-1", "-c", cwd,
    "-e", "SESSIONHOOK_SUBSCRIBER=sh_test-1",
    "-e", "SESSIONHOOK_CONFIG_DIR=/data/config",
    "-e", "SESSIONHOOK_STATE_DIR=/data/state",
  ]);
});

test("a bad name, topic, directory or prompt is refused before anything is touched", async () => {
  const cases: Array<[Partial<SpawnRequest>, RegExp]> = [
    [{ name: "has space" }, /invalid session name/],
    [{ name: "-leading" }, /invalid session name/],
    [{ name: "a.b" }, /invalid session name/],
    [{ topic: "not-a-topic" }, /invalid topic/],
    [{ cwd: join(cwd, "absent") }, /is not a directory/],
    [{ prompt: "--help" }, /cannot start with -/],
  ];
  for (const [request, message] of cases) {
    const { start, calls, events } = setUp();
    await assert.rejects(start(request), message);
    assert.deepEqual([calls, events], [[], []]);
  }
});

test("a tmux session of that name is refused without subscribing", async () => {
  const { start, calls, events } = setUp({ sessionExists: true });
  await assert.rejects(start({}), /a tmux session named proj-123 already exists.*tmux attach -t proj-123/);
  assert.deepEqual(events, []);
  assert.deepEqual(calls, [["/usr/bin/tmux", "has-session", "-t", "=proj-123"]]);
});

test("a broker that is down stops spawn before the session starts", async () => {
  const { start, events } = setUp({ subscribeFails: true });
  await assert.rejects(start({}), /the broker is not running, start it with `sessionhook serve`/);
  assert.deepEqual(events, []);
});

test("a missing tmux or claude is named, with the steps to do by hand", async () => {
  for (const program of ["tmux", "claude"]) {
    const { start, calls } = setUp({ located: { [program]: undefined } });
    await assert.rejects(start({ prompt: "Hi." }), (error: Error) => {
      assert.ok(error.message.startsWith(`${program} was not found on PATH`));
      assert.match(error.message, /sessionhook subscribe jira:PROJ-123 --name proj-123/);
      assert.match(error.message, /tmux new-session -d -s proj-123 -c .* -e SESSIONHOOK_SUBSCRIBER=proj-123 /);
      return true;
    });
    assert.deepEqual(calls, []);
  }
});

test("Enter is sent once, and only after the dialog text shows on the screen", async () => {
  const { start, calls, output } = setUp({ screens: ["", "Do you trust this folder?\n", dialog, "ready\n"] });
  await start({});
  const keys = calls.filter((call) => call[1] === "send-keys");
  assert.deepEqual(keys, [["/usr/bin/tmux", "send-keys", "-t", "proj-123", "Enter"]]);
  const captures = calls.filter((call) => call[1] === "capture-pane").length;
  assert.equal(captures, 4);
  assert.deepEqual(output.at(-1), "Pressed Enter at the development channels dialog, the session is running.");
});

test("no key is sent when the dialog never appears, and the output says how to attach", async () => {
  const { start, calls, output } = setUp({ screens: ["Do you trust this folder?\n 1. Yes\n"] });
  await start({});
  assert.equal(calls.filter((call) => call[1] === "send-keys").length, 0);
  assert.equal(calls.filter((call) => call[1] === "capture-pane").length, 60);
  assert.match(output.at(-1)!, /did not appear within 30 seconds, so no key was sent.*tmux attach -t proj-123/);
});

test("a dialog that is still showing after the key is reported", async () => {
  const { start, output } = setUp({ screens: [dialog] });
  await start({});
  assert.match(output.at(-1)!, /still showing.*tmux attach -t proj-123/);
});

test("--no-confirm never looks at the pane or sends a key", async () => {
  const { start, calls, output } = setUp();
  await start({ confirmDialog: false });
  assert.deepEqual(calls.map((call) => call[1]), ["has-session", "new-session"]);
  assert.match(output.at(-1)!, /Not answering.*tmux attach -t proj-123.*Enter/);
});

test("a session that ends before the dialog appears is reported", async () => {
  const { start } = setUp({ screens: ["ended"] });
  await assert.rejects(start({}), /the tmux session proj-123 ended before the dialog appeared/);
});

test("a tmux that cannot start the session reports its message", async () => {
  const calls: string[][] = [];
  const spawner = new Spawner({
    config: { claudeFlags: [] },
    env: {},
    client: { subscribe: async () => {} },
    run: async (file, args) => {
      calls.push([file, ...args]);
      return args[0] === "new-session" ? { code: 1, stdout: "", stderr: "unknown option -- e\n" } : { code: 1, stdout: "", stderr: "" };
    },
    locate: (program) => `/usr/bin/${program}`,
    sleep: async () => {},
    out: () => {},
  });
  await assert.rejects(spawner.start({ topic: "jira:PROJ-123", cwd, confirmDialog: true }), /tmux could not start the session: unknown option -- e/);
});
