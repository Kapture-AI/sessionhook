import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CommandNotFoundError, type Runner } from "./exec.js";

export type ServiceSpec = {
  nodePath: string;
  cliPath: string;
  // Only the variables that are set in the environment of the installing command, so a
  // non-default location carries over to the service.
  environment: Record<string, string>;
};

const unitName = "sessionhook.service";
const launchdLabel = "com.sessionhook.broker";

function unitQuote(value: string, expandsDollar: boolean): string {
  let escaped = value.replaceAll("%", "%%");
  // A function replacer, because "$$" in a replacement string would insert a single dollar sign.
  if (expandsDollar) escaped = escaped.replaceAll("$", () => "$$");
  if (/^[A-Za-z0-9_\/.:@+%-]+$/.test(escaped)) return escaped;
  return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function systemdUnit(spec: ServiceSpec): string {
  const execStart = [spec.nodePath, spec.cliPath, "serve"].map((part) => unitQuote(part, true)).join(" ");
  const environment = Object.entries(spec.environment).map(
    ([name, value]) => `Environment="${name}=${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
  );
  return [
    "[Unit]",
    "Description=sessionhook broker",
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=2",
    ...environment,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function launchdPlist(spec: ServiceSpec, logFile: string): string {
  const strings = (values: string[]) => values.map((value) => `    <string>${xmlEscape(value)}</string>`);
  const environment = Object.entries(spec.environment);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${launchdLabel}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...strings([spec.nodePath, spec.cliPath, "serve"]),
    "  </array>",
    ...(environment.length === 0
      ? []
      : [
          "  <key>EnvironmentVariables</key>",
          "  <dict>",
          ...environment.flatMap(([name, value]) => [
            `    <key>${xmlEscape(name)}</key>`,
            `    <string>${xmlEscape(value)}</string>`,
          ]),
          "  </dict>",
        ]),
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>2</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(logFile)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function mustRun(run: Runner, file: string, args: string[]): Promise<string> {
  let result;
  try {
    result = await run(file, args);
  } catch (error) {
    if (error instanceof CommandNotFoundError) {
      throw new Error(`${file} was not found, so the service cannot be managed on this machine`);
    }
    throw error;
  }
  if (result.code !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`${file} ${args.join(" ")} failed: ${reason}`);
  }
  return result.stdout;
}

// One manager per platform, each knowing its file and how to start, stop and query it.
interface ServiceManager {
  readonly file: string;
  render(spec: ServiceSpec): string;
  start(replacing: boolean): Promise<string[]>;
  stop(): Promise<void>;
  afterRemoval?(): Promise<void>;
  state(): Promise<string>;
}

class SystemdManager implements ServiceManager {
  readonly file: string;

  constructor(
    home: string,
    private readonly uid: number,
    private readonly run: Runner,
  ) {
    this.file = join(home, ".config", "systemd", "user", unitName);
  }

  render(spec: ServiceSpec): string {
    return systemdUnit(spec);
  }

  async start(replacing: boolean): Promise<string[]> {
    await mustRun(this.run, "systemctl", ["--user", "daemon-reload"]);
    await mustRun(this.run, "systemctl", ["--user", "enable", "--now", unitName]);
    // enable --now leaves a unit that is already running on its old definition.
    if (replacing) await mustRun(this.run, "systemctl", ["--user", "restart", unitName]);
    return [`enabled and started ${unitName} with systemctl --user`, ...(await this.lingerNote())];
  }

  async stop(): Promise<void> {
    await mustRun(this.run, "systemctl", ["--user", "disable", "--now", unitName]);
  }

  async afterRemoval(): Promise<void> {
    await mustRun(this.run, "systemctl", ["--user", "daemon-reload"]);
  }

  async state(): Promise<string> {
    const result = await this.run("systemctl", ["--user", "is-active", unitName]);
    return result.stdout.trim() || "unknown";
  }

  private async lingerNote(): Promise<string[]> {
    let result;
    try {
      result = await this.run("loginctl", ["show-user", String(this.uid), "--property=Linger"]);
    } catch (error) {
      // Without loginctl there is nothing to report, and the service itself is already running.
      if (error instanceof CommandNotFoundError) return [];
      throw error;
    }
    if (result.stdout.trim() !== "Linger=no") return [];
    return [
      "lingering is off, so the service stops when you log out and starts again at your next login.",
      "To keep it running after logout, run: loginctl enable-linger",
    ];
  }
}

class LaunchdManager implements ServiceManager {
  readonly file: string;
  readonly logFile: string;
  private readonly domain: string;

  constructor(
    home: string,
    uid: number,
    private readonly run: Runner,
  ) {
    this.file = join(home, "Library", "LaunchAgents", `${launchdLabel}.plist`);
    this.logFile = join(home, "Library", "Logs", "sessionhook.log");
    this.domain = `gui/${uid}`;
  }

  render(spec: ServiceSpec): string {
    return launchdPlist(spec, this.logFile);
  }

  async start(replacing: boolean): Promise<string[]> {
    if (replacing) await this.stop();
    await mustRun(this.run, "launchctl", ["bootstrap", this.domain, this.file]);
    return [`loaded ${launchdLabel} with launchctl, its output goes to ${this.logFile}`];
  }

  // Booting out an agent that is not loaded fails, and a stale file must still be replaceable and removable.
  async stop(): Promise<void> {
    await this.run("launchctl", ["bootout", `${this.domain}/${launchdLabel}`]);
  }

  async state(): Promise<string> {
    const result = await this.run("launchctl", ["print", `${this.domain}/${launchdLabel}`]);
    return result.code === 0 ? "loaded" : "not loaded";
  }
}

export type ServiceEnvironment = { platform: NodeJS.Platform; home: string; uid: number; run: Runner };

export class ServiceInstaller {
  private readonly manager: ServiceManager;

  constructor({ platform, home, uid, run }: ServiceEnvironment) {
    if (platform === "linux") this.manager = new SystemdManager(home, uid, run);
    else if (platform === "darwin") this.manager = new LaunchdManager(home, uid, run);
    else throw new Error(`the service install supports Linux and macOS, not ${platform}`);
  }

  get file(): string {
    return this.manager.file;
  }

  isInstalled(): boolean {
    return existsSync(this.manager.file);
  }

  // Returns the lines to show. An existing file is replaced only when confirmReplace says yes.
  async install(spec: ServiceSpec, confirmReplace: (file: string) => Promise<boolean>): Promise<string[]> {
    const replacing = this.isInstalled();
    if (replacing && !(await confirmReplace(this.manager.file))) {
      return [`left ${this.manager.file} as it is`];
    }
    mkdirSync(dirname(this.manager.file), { recursive: true });
    writeFileSync(this.manager.file, this.manager.render(spec));
    return [`wrote ${this.manager.file}`, ...(await this.manager.start(replacing))];
  }

  async uninstall(): Promise<string[]> {
    if (!this.isInstalled()) return [`the service is not installed, ${this.manager.file} does not exist`];
    await this.manager.stop();
    rmSync(this.manager.file);
    await this.manager.afterRemoval?.();
    return [`stopped the service and removed ${this.manager.file}`];
  }

  async status(): Promise<string[]> {
    if (!this.isInstalled()) return [`the service is not installed, ${this.manager.file} does not exist`];
    return [`${this.manager.file} exists, state: ${await this.manager.state()}`];
  }
}
