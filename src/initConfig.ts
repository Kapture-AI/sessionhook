import type { Config, JiraSourceConfig, SourceConfig } from "./config.js";

export const jiraSourceName = "jira";
export const tokenSecretName = "JIRA_API_TOKEN";
export const webhookSecretName = "JIRA_WEBHOOK_SECRET";

export type JiraMode = "poll" | "webhook" | "both";

export type JiraSetup = {
  site: string;
  email: string | undefined;
  mode: JiraMode;
  publicUrl: string | undefined;
  allowActors: string[];
  ignoreMarker: string;
};

type Json = Record<string, unknown>;

export function modeOf(source: JiraSourceConfig): JiraMode {
  if (source.poll && source.webhookSecret) return "both";
  return source.poll ? "poll" : "webhook";
}

export function pollsJira(mode: JiraMode): boolean {
  return mode !== "webhook";
}

export function receivesJiraWebhooks(mode: JiraMode): boolean {
  return mode !== "poll";
}

// Returns the raw config with the Jira source set up. Every other key, source and
// setting of the Jira source that init does not ask about is kept as it was.
export function applyJiraSetup(existing: Json, setup: JiraSetup): Json {
  const sources = { ...((existing.sources as Json | undefined) ?? {}) };
  const previous = sources[jiraSourceName] as Json | undefined;
  const kept = previous?.type === "jira" ? { ...previous } : {};
  for (const key of ["email", "token", "poll", "webhookSecret"]) delete kept[key];

  const source: Json = { ...kept, type: "jira", site: setup.site };
  if (pollsJira(setup.mode)) {
    source.email = setup.email;
    source.token = tokenSecretName;
    source.poll = (previous?.type === "jira" ? previous.poll : undefined) ?? {};
  }
  if (receivesJiraWebhooks(setup.mode)) source.webhookSecret = webhookSecretName;
  source.allowActors = setup.allowActors;
  source.ignoreMarker = setup.ignoreMarker;

  const config: Json = { ...existing, sources: { ...sources, [jiraSourceName]: source } };
  if (setup.publicUrl !== undefined) config.publicUrl = setup.publicUrl;
  return config;
}

function describeSource(name: string, source: SourceConfig): string {
  if (source.type === "webhook") return `  source ${name}: generic webhook, header ${source.signature.header}`;
  const parts = [`jira ${source.site}`, `mode ${modeOf(source)}`];
  if (source.email) parts.push(`account ${source.email}`);
  parts.push(source.allowActors.length === 0 ? "anyone may wake a session" : `allowed: ${source.allowActors.join(", ")}`);
  return `  source ${name}: ${parts.join(", ")}`;
}

// Secrets are held under names in the config, so this never has a value to show.
export function summarizeConfig(config: Config): string[] {
  const sources = Object.entries(config.sources).map(([name, source]) => describeSource(name, source));
  return [
    `  listen: ${config.listen.host}:${config.listen.port}`,
    ...(config.publicUrl ? [`  publicUrl: ${config.publicUrl}`] : []),
    ...(sources.length === 0 ? ["  no sources"] : sources),
  ];
}
