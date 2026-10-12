import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { BrokerClient } from "./client.js";
import type { SpawnConfig } from "./config.js";
import { parseTopic } from "./event.js";
import type { Runner } from "./exec.js";
import { locationEnvironment } from "./paths.js";
import { quoteCommand } from "./shellQuote.js";
import { checkSubscriberName } from "./subscriber.js";

const dialogText = "Loading development channels";
const sessionNamePattern = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const dialogPolls = 60;
const dialogPollMs = 500;

export type SpawnRequest = {
  topic: string;
  cwd: string;
  name?: string;
  prompt?: string;
  // False leaves the dialog for the user to answer.
  confirmDialog: boolean;
};

export type SpawnDeps = {
  config: SpawnConfig;
  env: NodeJS.ProcessEnv;
  client: Pick<BrokerClient, "subscribe">;
  run: Runner;
  locate: (program: string) => string | undefined;
  sleep: (milliseconds: number) => Promise<void>;
  out: (line: string) => void;
};

// jira:PROJ-123 gives proj-123. The key alone names the session, the source is the part
// the user already typed.
export function defaultSessionName(topic: string): string {
  const { key } = parseTopic(topic);
  const name = key.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (name === "") throw new Error(`cannot derive a session name from "${topic}", pass --name`);
  return name;
}

function defaultPrompt(topic: string): string {
  return `You are subscribed to ${topic} through the sessionhook channel. Events for that topic arrive as channel messages. Wait for them, and act on each one as it arrives.`;
}

export class Spawner {
  constructor(private readonly deps: SpawnDeps) {}

  async start(request: SpawnRequest): Promise<void> {
    const { topic } = request;
    parseTopic(topic);
    const name = request.name ?? defaultSessionName(topic);
    if (!sessionNamePattern.test(name)) {
      throw new Error(`invalid session name "${name}", use letters, digits, _ and -, up to 64 characters, not starting with -`);
    }
    checkSubscriberName(name);
    const cwd = resolve(request.cwd);
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${cwd} is not a directory`);

    const prompt = request.prompt ?? this.deps.config.prompt ?? defaultPrompt(topic);
    if (prompt.startsWith("-")) throw new Error("the prompt cannot start with -, claude would read it as an option");

    const tmux = this.deps.locate("tmux");
    const claude = this.deps.locate("claude");
    const claudeCommand = quoteCommand([
      claude ?? "claude",
      prompt,
      ...this.deps.config.claudeFlags,
      "--dangerously-load-development-channels",
      "server:sessionhook",
    ]);
    const tmuxArguments = [
      "new-session", "-d", "-s", name, "-c", cwd,
      "-e", `SESSIONHOOK_SUBSCRIBER=${name}`,
      ...Object.entries(locationEnvironment(this.deps.env)).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      claudeCommand,
    ];
    const byHand = [
      `  sessionhook subscribe ${quoteCommand([topic, "--name", name])}`,
      `  ${quoteCommand(["tmux", ...tmuxArguments])}`,
    ].join("\n");
    if (!tmux) throw new Error(`tmux was not found on PATH, install tmux 3.2 or later. By hand, the steps are:\n${byHand}`);
    if (!claude) throw new Error(`claude was not found on PATH, install Claude Code. By hand, the steps are:\n${byHand}`);

    const existing = await this.deps.run(tmux, ["has-session", "-t", `=${name}`]);
    if (existing.code === 0) {
      throw new Error(`a tmux session named ${name} already exists, attach with \`tmux attach -t ${name}\` or pass another --name`);
    }

    await this.deps.client.subscribe(name, topic);
    const created = await this.deps.run(tmux, tmuxArguments);
    if (created.code !== 0) {
      throw new Error(`tmux could not start the session: ${created.stderr.trim() || `exit code ${created.code}`}`);
    }
    this.deps.out(`Started tmux session ${name} in ${cwd}, subscribed as ${name} to ${topic}.`);
    await this.acceptDialog(tmux, name, request.confirmDialog);
  }

  // Claude Code asks about development channels at every start. The key is sent only when
  // that dialog is on the screen, so another prompt, such as a folder trust question, is never answered blindly.
  private async acceptDialog(tmux: string, name: string, confirmDialog: boolean): Promise<void> {
    const attach = `tmux attach -t ${name}`;
    if (!confirmDialog) {
      this.deps.out(`Not answering the development channels dialog. Attach with \`${attach}\` and press Enter, option 1 is preselected.`);
      return;
    }
    for (let poll = 0; poll < dialogPolls; poll++) {
      if (await this.dialogShowing(tmux, name)) {
        const sent = await this.deps.run(tmux, ["send-keys", "-t", name, "Enter"]);
        if (sent.code !== 0) throw new Error(`tmux could not send the key: ${sent.stderr.trim() || `exit code ${sent.code}`}`);
        await this.deps.sleep(1000);
        const stillShowing = await this.dialogShowing(tmux, name);
        this.deps.out(
          stillShowing
            ? `Pressed Enter at the development channels dialog, but it is still showing. Attach with \`${attach}\`.`
            : "Pressed Enter at the development channels dialog, the session is running.",
        );
        return;
      }
      await this.deps.sleep(dialogPollMs);
    }
    this.deps.out(`The development channels dialog did not appear within 30 seconds, so no key was sent. The session may be waiting on a prompt, attach with \`${attach}\`.`);
  }

  private async dialogShowing(tmux: string, name: string): Promise<boolean> {
    const pane = await this.deps.run(tmux, ["capture-pane", "-p", "-t", name]);
    if (pane.code !== 0) {
      throw new Error(`the tmux session ${name} ended before the dialog appeared, run the claude command by hand to see why it stopped`);
    }
    return pane.stdout.includes(dialogText);
  }
}
