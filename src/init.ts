import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { channelServerArguments, type ClaudeCli } from "./claudeCli.js";
import { loadConfig, parseHttpsOrigin, validateConfig } from "./config.js";
import { CommandNotFoundError } from "./exec.js";
import {
  applyJiraSetup,
  jiraSourceName,
  pollsJira,
  receivesJiraWebhooks,
  summarizeConfig,
  tokenSecretName,
  webhookSecretName,
  modeOf,
  type JiraMode,
} from "./initConfig.js";
import { checkJiraAccount } from "./jiraAccount.js";
import type { Paths } from "./paths.js";
import type { Prompter } from "./prompter.js";
import { lookupSecret, readSecretsFile, writeSecretsFile } from "./secrets.js";
import type { ServiceInstaller, ServiceSpec } from "./service.js";
import { quoteArgument, quoteCommand } from "./shellQuote.js";

export type InitOptions = {
  site?: string;
  email?: string;
  mode?: string;
  tokenFile?: string;
  publicUrl?: string;
  allowActors: string[];
  ignoreMarker?: string;
  service?: boolean;
  register?: boolean;
  yes: boolean;
};

export type InitDeps = {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  // Absent with --yes, which never asks.
  prompter?: Prompter;
  fetch: typeof fetch;
  claude: ClaudeCli;
  services: ServiceInstaller;
  serviceSpec: ServiceSpec;
  out: (line: string) => void;
  err: (line: string) => void;
};

type Json = Record<string, unknown>;

const modes = ["poll", "webhook", "both"];

function readRawConfig(file: string): Json | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as Json;
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}), fix or remove it and run init again`);
  }
}

function readTokenFile(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read the token file ${file}: ${(error as Error).message}`);
  }
  const token = text.trim();
  if (token === "") throw new Error(`the token file ${file} is empty`);
  return token;
}

// Answers come from a flag first, then from the existing setup, then from a question.
// With --yes there are no questions, so a missing required answer is an error.
class Answers {
  constructor(
    private readonly yes: boolean,
    private readonly prompter: Prompter | undefined,
  ) {}

  async text(flag: string | undefined, flagName: string, question: string, fallback?: string): Promise<string> {
    if (flag !== undefined) return flag;
    if (this.yes || !this.prompter) {
      if (fallback) return fallback;
      throw new Error(`${flagName} is needed when init runs with --yes`);
    }
    for (;;) {
      const answer = await this.prompter.ask(question, fallback);
      if (answer) return answer;
    }
  }

  // The empty string is a valid answer.
  async optionalText(flag: string | undefined, question: string, fallback: string): Promise<string> {
    if (flag !== undefined) return flag;
    if (this.yes || !this.prompter) return fallback;
    return this.prompter.ask(question, fallback);
  }

  async yesNo(flag: boolean | undefined, question: string, fallback: boolean): Promise<boolean> {
    if (flag !== undefined) return flag;
    if (this.yes || !this.prompter) return fallback;
    return this.prompter.confirm(question, fallback);
  }

  async secret(question: string, flagName: string): Promise<string> {
    if (this.yes || !this.prompter) throw new Error(`${flagName} is needed when init runs with --yes`);
    for (;;) {
      const answer = await this.prompter.secret(question);
      if (answer) return answer;
    }
  }
}

function listFrom(text: string): string[] {
  return text.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

// Returns the problems that were reported but did not stop init, so the command can exit non-zero.
export async function runInit(options: InitOptions, deps: InitDeps): Promise<string[]> {
  const { paths, env, out } = deps;
  const answers = new Answers(options.yes, deps.prompter);
  const problems: string[] = [];

  const existingRaw = readRawConfig(paths.configFile);
  const existing = existingRaw === undefined ? undefined : loadConfig(paths.configFile);
  if (existing) {
    out(`${paths.configFile} already exists:`);
    summarizeConfig(existing).forEach(out);
    const proceed = await answers.yesNo(undefined, `Set up the ${jiraSourceName} source in it? Other sources are kept`, true);
    if (!proceed) {
      out("left the config as it was, nothing was written");
      return problems;
    }
  }
  const previous = existing?.sources[jiraSourceName];
  const previousJira = previous?.type === "jira" ? previous : undefined;

  const site = parseHttpsOrigin(
    await answers.text(options.site, "--site", "Jira site address", previousJira?.site),
    "the site",
    "https://example.atlassian.net",
  );
  const modeText = await answers.text(options.mode, "--mode", "Get events by poll, webhook or both", previousJira ? modeOf(previousJira) : "poll");
  if (!modes.includes(modeText)) throw new Error(`the mode is "${modeText}", expected poll, webhook or both`);
  const mode = modeText as JiraMode;

  let email: string | undefined;
  let newToken: string | undefined;
  if (pollsJira(mode)) {
    email = await answers.text(options.email, "--email", "Email of the Atlassian account that owns the API token", previousJira?.email);
    if (!email.includes("@")) throw new Error(`"${email}" is not an email address`);
  }
  const storedToken = lookupSecret(tokenSecretName, paths.secretsFile, env);
  if (pollsJira(mode)) {
    if (options.tokenFile !== undefined) {
      newToken = readTokenFile(options.tokenFile);
    } else if (storedToken === undefined) {
      newToken = await answers.secret("Jira API token (typing is hidden)", "--token-file");
    } else if (!(await answers.yesNo(undefined, `A Jira API token is already stored as ${tokenSecretName}. Keep it?`, true))) {
      newToken = await answers.secret("Jira API token (typing is hidden)", "--token-file");
    }
    if (newToken !== undefined && storedToken !== undefined && newToken !== storedToken) {
      const replace = await answers.yesNo(undefined, `Replace the stored ${tokenSecretName} with the new token?`, true);
      if (!replace) newToken = undefined;
    }
  }

  let publicUrl: string | undefined;
  if (receivesJiraWebhooks(mode) || options.publicUrl !== undefined) {
    const text = await answers.text(options.publicUrl, "--public-url", "Public address that reaches the webhook listener", existing?.publicUrl);
    publicUrl = parseHttpsOrigin(text, "the public address", "https://hooks.example.com");
  }
  const allowActors =
    options.allowActors.length > 0
      ? options.allowActors
      : listFrom(
          await answers.optionalText(
            undefined,
            "Who may wake a session (Atlassian display names or account ids, comma separated, empty for anyone)",
            (previousJira?.allowActors ?? []).join(", "),
          ),
        );
  const ignoreMarker = await answers.optionalText(
    options.ignoreMarker,
    "Text that marks your agent's own comments so they wake nobody (empty for none)",
    previousJira?.ignoreMarker ?? "",
  );

  if (pollsJira(mode)) {
    const token = newToken ?? storedToken!;
    const account = await checkJiraAccount(site, email!, token, deps.fetch);
    if (!account.ok) throw new Error(`${account.message}, nothing was written`);
    out(`Authenticated to ${site} as ${account.displayName}.`);
  }

  const secrets = readSecretsFile(paths.secretsFile);
  const stored: string[] = [];
  if (newToken !== undefined) {
    secrets[tokenSecretName] = newToken;
    stored.push(tokenSecretName);
  }
  if (receivesJiraWebhooks(mode) && lookupSecret(webhookSecretName, paths.secretsFile, env) === undefined) {
    secrets[webhookSecretName] = randomBytes(32).toString("hex");
    stored.push(webhookSecretName);
  }
  const rawConfig = applyJiraSetup(existingRaw ?? {}, { site, email, mode, publicUrl, allowActors, ignoreMarker });
  validateConfig(rawConfig);
  if (stored.length > 0) {
    writeSecretsFile(paths.secretsFile, secrets);
    out(`Stored ${stored.join(" and ")} in ${paths.secretsFile} (mode 600).`);
  }
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, `${JSON.stringify(rawConfig, null, 2)}\n`);
  out(`Wrote ${paths.configFile}.`);

  await registerChannelServer(options, answers, deps, problems);
  const serviceStarted = await installService(options, answers, deps, problems);
  printNextSteps(out, { mode, publicUrl, paths, serviceStarted, openToAnyone: allowActors.length === 0 });
  return problems;
}

async function registerChannelServer(options: InitOptions, answers: Answers, deps: InitDeps, problems: string[]): Promise<void> {
  const { nodePath, cliPath } = deps.serviceSpec;
  const wanted = await answers.yesNo(options.register, "Register the sessionhook channel server with Claude Code (user scope)?", true);
  if (!wanted) return;
  const command = quoteCommand(["claude", ...channelServerArguments(nodePath, cliPath)]);
  try {
    if (await deps.claude.hasServer()) {
      deps.out("The sessionhook channel server is already registered with Claude Code, left as it is.");
      return;
    }
    await deps.claude.addServer(nodePath, cliPath);
    deps.out("Registered the sessionhook channel server with Claude Code at user scope.");
  } catch (error) {
    if (error instanceof CommandNotFoundError) {
      deps.out(`claude was not found on PATH. To register the channel server later, run:\n  ${command}`);
      return;
    }
    problems.push("could not register the channel server");
    deps.err(`could not register the channel server: ${(error as Error).message}\nTo do it by hand, run:\n  ${command}`);
  }
}

async function installService(options: InitOptions, answers: Answers, deps: InitDeps, problems: string[]): Promise<boolean> {
  const wanted = await answers.yesNo(options.service, "Install the broker as a service that starts at login?", true);
  if (!wanted) return false;
  try {
    const lines = await deps.services.install(deps.serviceSpec, async (file) => {
      deps.out(`${file} already exists.`);
      return answers.yesNo(undefined, "Replace it?", true);
    });
    lines.forEach(deps.out);
    return deps.services.isInstalled();
  } catch (error) {
    problems.push("could not install the service");
    deps.err(`could not install the service: ${(error as Error).message}\nStart the broker yourself with: sessionhook serve`);
    return false;
  }
}

function printNextSteps(
  out: (line: string) => void,
  context: { mode: JiraMode; publicUrl: string | undefined; paths: Paths; serviceStarted: boolean; openToAnyone: boolean },
): void {
  const { mode, publicUrl, paths } = context;
  out("");
  if (receivesJiraWebhooks(mode)) {
    const printSecret = `node -p ${quoteArgument(`require(${JSON.stringify(paths.secretsFile)}).${webhookSecretName}`)}`;
    out("In Jira, open Settings, System, WebHooks and create a webhook with these settings.");
    out(`  URL:     ${publicUrl}/hooks/${jiraSourceName}`);
    out("  Events:  Issue: updated, Comment: created, Comment: updated");
    out(`  Secret:  the value of ${webhookSecretName} in ${paths.secretsFile}`);
    out("To print the secret for pasting, run:");
    out(`  ${printSecret}`);
    out("");
  }
  if (context.openToAnyone) {
    out("No allowlist is set, so anyone who can comment on a ticket you subscribe to can wake a session.");
    out('Add names to "allowActors" in the config to limit that.');
    out("");
  }
  out("Next:");
  if (!context.serviceStarted) out("  sessionhook serve                      run the broker in a terminal of its own");
  out("  sessionhook doctor                     check the setup");
  out("  sessionhook spawn jira:PROJ-123        start a Claude Code session in tmux that receives the ticket's events");
  out("  sessionhook subscribe jira:PROJ-123 --name my-session && sessionhook wait --name my-session");
  out("                                         or subscribe by hand and wait for the next event");
}
