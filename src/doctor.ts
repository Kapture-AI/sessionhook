import { createHmac, randomBytes } from "node:crypto";
import { BrokerNotRunningError, type BrokerClient } from "./client.js";
import { supportsChannels, type ClaudeCli } from "./claudeCli.js";
import { loadConfig, type Config, type JiraSourceConfig } from "./config.js";
import { CommandNotFoundError } from "./exec.js";
import { describeFetchError } from "./fetchError.js";
import { checkJiraAccount } from "./jiraAccount.js";
import type { Paths } from "./paths.js";
import { lookupSecret } from "./secrets.js";

export type CheckResult = { name: string; status: "ok" | "FAIL" | "skip"; detail: string };

export type DoctorDeps = {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  client: Pick<BrokerClient, "status">;
  fetch: typeof fetch;
  claude: ClaudeCli;
  registerCommand: string;
};

const probeTimeoutMs = 10_000;

const ok = (name: string, detail: string): CheckResult => ({ name, status: "ok", detail });
const fail = (name: string, detail: string): CheckResult => ({ name, status: "FAIL", detail });
const skip = (name: string, detail: string): CheckResult => ({ name, status: "skip", detail });

function secretNames(config: Config): string[] {
  return Object.values(config.sources).flatMap((source) => {
    if (source.type === "webhook") return [source.signature.secret];
    return [...(source.poll ? [source.token!] : []), ...(source.webhookSecret ? [source.webhookSecret] : [])];
  });
}

function checkConfig(deps: DoctorDeps): { result: CheckResult; config?: Config } {
  const name = "config";
  let config: Config;
  try {
    config = loadConfig(deps.paths.configFile);
  } catch (error) {
    return { result: fail(name, (error as Error).message) };
  }
  try {
    const missing = secretNames(config).filter((secret) => !lookupSecret(secret, deps.paths.secretsFile, deps.env));
    if (missing.length > 0) {
      return { result: fail(name, `${deps.paths.configFile} loads, but the secret ${missing.join(", ")} was found in neither ${deps.paths.secretsFile} nor the environment`), config };
    }
  } catch (error) {
    return { result: fail(name, (error as Error).message), config };
  }
  const count = Object.keys(config.sources).length;
  return { result: ok(name, `${deps.paths.configFile} loads, ${count} ${count === 1 ? "source" : "sources"}, every secret it names is found`), config };
}

async function checkBroker(deps: DoctorDeps): Promise<CheckResult> {
  try {
    const subscribers = await deps.client.status();
    return ok("broker", `answers on ${deps.paths.socketFile}, ${subscribers.length} ${subscribers.length === 1 ? "subscriber" : "subscribers"}`);
  } catch (error) {
    if (error instanceof BrokerNotRunningError) return fail("broker", error.message);
    return fail("broker", `the broker answered badly: ${(error as Error).message}`);
  }
}

async function checkJiraToken(deps: DoctorDeps, sourceName: string, source: JiraSourceConfig): Promise<CheckResult> {
  const name = `jira token (${sourceName})`;
  const token = lookupSecret(source.token!, deps.paths.secretsFile, deps.env);
  if (!token) return skip(name, `the secret ${source.token} was not found, see the config check`);
  const account = await checkJiraAccount(source.site, source.email!, token, deps.fetch);
  if (account.ok) return ok(name, `${source.site} accepted ${source.email}, authenticated as ${account.displayName}`);
  return fail(name, account.message);
}

// A correctly signed request that the Jira source answers with 200 and stores nothing for, since it
// is not an event kind it translates. Only this broker's listener, with this secret, gives that answer.
async function checkPublicUrl(deps: DoctorDeps, config: Config, sourceName: string, secretName: string): Promise<CheckResult> {
  const name = `public URL (${sourceName})`;
  if (!config.publicUrl) return skip(name, "publicUrl is not set in the config, so whether the public address reaches the listener was not tested");
  const secret = lookupSecret(secretName, deps.paths.secretsFile, deps.env);
  if (!secret) return skip(name, `the secret ${secretName} was not found, see the config check`);
  const url = `${config.publicUrl}/hooks/${sourceName}`;
  const body = JSON.stringify({ webhookEvent: "sessionhook:doctor", nonce: randomBytes(8).toString("hex") });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature": `sha256=${signature}` },
      body,
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
  } catch (error) {
    return fail(name, `${url} could not be reached (${describeFetchError(error)}), check the address, DNS and the proxy or tunnel`);
  }
  if (response.status === 401) {
    return fail(name, `${url} reached a listener that rejected the signature, so the address leads to a different broker or the webhook secret differs`);
  }
  if (response.status !== 200) {
    return fail(name, `${url} answered ${response.status}, which is not this broker's listener, check that the proxy forwards /hooks/ to ${config.listen.host}:${config.listen.port}`);
  }
  try {
    if (Array.isArray(((await response.json()) as { results?: unknown }).results)) {
      return ok(name, `${url} reaches this broker's listener and accepts its signature`);
    }
  } catch {
    // Handled below, the same as JSON without a results list.
  }
  return fail(name, `${url} answered 200 but not like the listener, so the address leads to something else`);
}

async function checkClaude(deps: DoctorDeps): Promise<CheckResult> {
  const name = "claude code";
  try {
    const version = await deps.claude.version();
    if (!supportsChannels(version)) return fail(name, `${version} is too old for channels, 2.1.80 or later is needed`);
    if (!(await deps.claude.hasServer())) {
      return fail(name, `${version}, but the sessionhook channel server is not registered, run \`sessionhook init\` or: ${deps.registerCommand}`);
    }
    return ok(name, `${version}, the sessionhook channel server is registered`);
  } catch (error) {
    if (error instanceof CommandNotFoundError) {
      return skip(name, "claude is not on PATH, which only matters for channel delivery, `sessionhook wait` needs nothing from Claude Code");
    }
    return fail(name, (error as Error).message);
  }
}

export async function runDoctor(deps: DoctorDeps): Promise<CheckResult[]> {
  const { result, config } = checkConfig(deps);
  const results = [result, await checkBroker(deps)];
  for (const [sourceName, source] of Object.entries(config?.sources ?? {})) {
    if (source.type !== "jira") continue;
    if (source.poll) results.push(await checkJiraToken(deps, sourceName, source));
    if (source.webhookSecret) results.push(await checkPublicUrl(deps, config!, sourceName, source.webhookSecret));
  }
  results.push(await checkClaude(deps));
  return results;
}

export function formatReport(results: CheckResult[]): string[] {
  const width = Math.max(...results.map((r) => r.name.length));
  return results.map((r) => `${r.status.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`);
}

export const channelsNote =
  "Organisations on Claude Team or Enterprise have channels off until an owner enables them, and doctor cannot see that setting. `sessionhook wait` works without channels.";
