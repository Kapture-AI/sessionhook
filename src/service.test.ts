import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandNotFoundError, type RunResult, type Runner } from "./exec.js";
import { ServiceInstaller, launchdPlist, systemdUnit, type ServiceSpec } from "./service.js";

const spec: ServiceSpec = {
  nodePath: "/usr/local/bin/node",
  cliPath: "/usr/local/lib/node_modules/sessionhook/dist/cli.js",
  environment: {},
};

let directory: string;
let counter = 0;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "sessionhook-service-"));
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

function freshHome(): string {
  const home = join(directory, `home-${counter++}`);
  mkdirSync(home);
  return home;
}

function recordingRunner(answers: Record<string, Partial<RunResult> | "missing"> = {}) {
  const calls: string[] = [];
  const run: Runner = async (file, args) => {
    const line = [file, ...args].join(" ");
    calls.push(line);
    const answer = answers[line] ?? answers[file];
    if (answer === "missing") throw new CommandNotFoundError(file);
    return { code: 0, stdout: "", stderr: "", ...answer };
  };
  return { run, calls };
}

test("the systemd unit restarts the broker and starts it at login", () => {
  assert.equal(
    systemdUnit(spec),
    [
      "[Unit]",
      "Description=sessionhook broker",
      "",
      "[Service]",
      "ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/sessionhook/dist/cli.js serve",
      "Restart=always",
      "RestartSec=2",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  );
});

test("the systemd unit quotes paths with spaces and carries the environment", () => {
  const unit = systemdUnit({
    nodePath: "/opt/my node/bin/node",
    cliPath: "/opt/100%/cli$.js",
    environment: { SESSIONHOOK_CONFIG_DIR: "/data/my config", SESSIONHOOK_STATE_DIR: "/data/state" },
  });
  assert.match(unit, /^ExecStart="\/opt\/my node\/bin\/node" "\/opt\/100%%\/cli\$\$\.js" serve$/m);
  assert.match(unit, /^Environment="SESSIONHOOK_CONFIG_DIR=\/data\/my config"$/m);
  assert.match(unit, /^Environment="SESSIONHOOK_STATE_DIR=\/data\/state"$/m);
});

test("the launchd plist keeps the broker alive, starts it at load and escapes its text", () => {
  const plist = launchdPlist(
    { ...spec, cliPath: "/Users/ada/a&b/cli.js", environment: { SESSIONHOOK_STATE_DIR: "/Users/ada/state" } },
    "/Users/ada/Library/Logs/sessionhook.log",
  );
  assert.equal(
    plist,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key>",
      "  <string>com.sessionhook.broker</string>",
      "  <key>ProgramArguments</key>",
      "  <array>",
      "    <string>/usr/local/bin/node</string>",
      "    <string>/Users/ada/a&amp;b/cli.js</string>",
      "    <string>serve</string>",
      "  </array>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>SESSIONHOOK_STATE_DIR</key>",
      "    <string>/Users/ada/state</string>",
      "  </dict>",
      "  <key>RunAtLoad</key>",
      "  <true/>",
      "  <key>KeepAlive</key>",
      "  <true/>",
      "  <key>ThrottleInterval</key>",
      "  <integer>2</integer>",
      "  <key>StandardOutPath</key>",
      "  <string>/Users/ada/Library/Logs/sessionhook.log</string>",
      "  <key>StandardErrorPath</key>",
      "  <string>/Users/ada/Library/Logs/sessionhook.log</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
});

test("the launchd plist has no environment block when nothing is carried over", () => {
  assert.ok(!launchdPlist(spec, "/log").includes("EnvironmentVariables"));
});

test("a platform other than Linux and macOS is refused", () => {
  assert.throws(
    () => new ServiceInstaller({ platform: "win32", home: "/h", uid: 1, run: recordingRunner().run }),
    /supports Linux and macOS, not win32/,
  );
});

test("install on Linux writes the unit, reloads systemd, enables it and notes that lingering is off", async () => {
  const home = freshHome();
  const { run, calls } = recordingRunner({
    "loginctl show-user 1000 --property=Linger": { stdout: "Linger=no\n" },
  });
  const installer = new ServiceInstaller({ platform: "linux", home, uid: 1000, run });
  const lines = await installer.install(spec, async () => assert.fail("nothing to replace"));
  const unitFile = join(home, ".config", "systemd", "user", "sessionhook.service");
  assert.equal(readFileSync(unitFile, "utf8"), systemdUnit(spec));
  assert.deepEqual(calls, [
    "systemctl --user daemon-reload",
    "systemctl --user enable --now sessionhook.service",
    "loginctl show-user 1000 --property=Linger",
  ]);
  assert.ok(lines.includes(`wrote ${unitFile}`));
  assert.match(lines.join("\n"), /lingering is off.*loginctl enable-linger/s);
});

test("install on Linux stays quiet about lingering when it is on or loginctl is missing", async () => {
  for (const linger of [{ stdout: "Linger=yes\n" }, "missing" as const]) {
    const { run } = recordingRunner({ loginctl: linger });
    const installer = new ServiceInstaller({ platform: "linux", home: freshHome(), uid: 1000, run });
    const lines = await installer.install(spec, async () => true);
    assert.ok(!lines.join("\n").includes("linger"), lines.join("\n"));
  }
});

test("an existing unit is replaced and restarted only after the confirmation says yes", async () => {
  const home = freshHome();
  const first = recordingRunner();
  const installer = new ServiceInstaller({ platform: "linux", home, uid: 1000, run: first.run });
  await installer.install(spec, async () => true);

  const declined = recordingRunner();
  const asked: string[] = [];
  const kept = await new ServiceInstaller({ platform: "linux", home, uid: 1000, run: declined.run }).install(
    { ...spec, nodePath: "/other/node" },
    async (file) => (asked.push(file), false),
  );
  assert.deepEqual(asked, [installer.file]);
  assert.deepEqual(declined.calls, []);
  assert.match(kept[0]!, /^left .* as it is$/);
  assert.equal(readFileSync(installer.file, "utf8"), systemdUnit(spec));

  const accepted = recordingRunner();
  await new ServiceInstaller({ platform: "linux", home, uid: 1000, run: accepted.run }).install(
    { ...spec, nodePath: "/other/node" },
    async () => true,
  );
  assert.match(readFileSync(installer.file, "utf8"), /ExecStart=\/other\/node /);
  assert.ok(accepted.calls.includes("systemctl --user restart sessionhook.service"));
});

test("a failing systemctl surfaces its message and a missing one says what that means", async () => {
  const failing = recordingRunner({ systemctl: { code: 1, stderr: "Failed to connect to bus\n" } });
  await assert.rejects(
    new ServiceInstaller({ platform: "linux", home: freshHome(), uid: 1, run: failing.run }).install(spec, async () => true),
    /systemctl --user daemon-reload failed: Failed to connect to bus/,
  );
  const missing = recordingRunner({ systemctl: "missing" });
  await assert.rejects(
    new ServiceInstaller({ platform: "linux", home: freshHome(), uid: 1, run: missing.run }).install(spec, async () => true),
    /systemctl was not found, so the service cannot be managed on this machine/,
  );
});

test("uninstall on Linux stops, disables and removes the unit, and status follows", async () => {
  const home = freshHome();
  const { run, calls } = recordingRunner({
    "systemctl --user is-active sessionhook.service": { stdout: "active\n" },
  });
  const installer = new ServiceInstaller({ platform: "linux", home, uid: 1, run });
  assert.match((await installer.status())[0]!, /is not installed/);
  await installer.install(spec, async () => true);
  assert.match((await installer.status())[0]!, /state: active$/);
  calls.length = 0;
  await installer.uninstall();
  assert.deepEqual(calls, ["systemctl --user disable --now sessionhook.service", "systemctl --user daemon-reload"]);
  assert.equal(existsSync(installer.file), false);
  assert.match((await installer.uninstall())[0]!, /is not installed/);
});

test("install on macOS writes the agent and bootstraps it into the user's domain", async () => {
  const home = freshHome();
  const { run, calls } = recordingRunner();
  const installer = new ServiceInstaller({ platform: "darwin", home, uid: 501, run });
  await installer.install({ ...spec, environment: { SESSIONHOOK_STATE_DIR: "/s" } }, async () => true);
  const plistFile = join(home, "Library", "LaunchAgents", "com.sessionhook.broker.plist");
  assert.equal(installer.file, plistFile);
  assert.equal(
    readFileSync(plistFile, "utf8"),
    launchdPlist({ ...spec, environment: { SESSIONHOOK_STATE_DIR: "/s" } }, join(home, "Library", "Logs", "sessionhook.log")),
  );
  assert.deepEqual(calls, [`launchctl bootstrap gui/501 ${plistFile}`]);
});

test("replacing a macOS agent boots out the old one first, and a stale agent can still be removed", async () => {
  const home = freshHome();
  const first = new ServiceInstaller({ platform: "darwin", home, uid: 501, run: recordingRunner().run });
  await first.install(spec, async () => true);

  const replaced = recordingRunner();
  await new ServiceInstaller({ platform: "darwin", home, uid: 501, run: replaced.run }).install(spec, async () => true);
  assert.deepEqual(replaced.calls.map((call) => call.split(" ")[1]), ["bootout", "bootstrap"]);

  const notLoaded = recordingRunner({ launchctl: { code: 113, stderr: "no such service" } });
  const stale = new ServiceInstaller({ platform: "darwin", home, uid: 501, run: notLoaded.run });
  assert.match((await stale.status())[0]!, /state: not loaded$/);
  await stale.uninstall();
  assert.equal(existsSync(stale.file), false);
  assert.equal(notLoaded.calls.at(-1), "launchctl bootout gui/501/com.sessionhook.broker");
});

test("the service command works end to end against stand-in systemctl and loginctl programs", () => {
  const home = freshHome();
  const bin = join(home, "bin");
  mkdirSync(bin);
  const log = join(home, "calls.log");
  for (const program of ["systemctl", "loginctl"]) {
    writeFileSync(join(bin, program), `#!/bin/sh\necho "${program} $*" >> "${log}"\n`);
    chmodSync(join(bin, program), 0o755);
  }
  const cli = new URL("./cli.js", import.meta.url).pathname;
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, SESSIONHOOK_STATE_DIR: join(home, "state") };
  const installed = spawnSync(process.execPath, [cli, "service", "install", "--yes"], { env, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
  const unit = readFileSync(join(home, ".config", "systemd", "user", "sessionhook.service"), "utf8");
  assert.ok(unit.includes(`ExecStart=${process.execPath} ${cli} serve`));
  assert.ok(unit.includes(`Environment="SESSIONHOOK_STATE_DIR=${join(home, "state")}"`));
  assert.match(readFileSync(log, "utf8"), /^systemctl --user daemon-reload\nsystemctl --user enable --now sessionhook.service\n/);
  const removed = spawnSync(process.execPath, [cli, "service", "uninstall", "--yes"], { env, encoding: "utf8" });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(join(home, ".config", "systemd", "user", "sessionhook.service")), false);
  const bad = spawnSync(process.execPath, [cli, "service", "frobnicate"], { env, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage: sessionhook service install\|uninstall\|status/);
});
