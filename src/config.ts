import { readFileSync } from "node:fs";

export type IntakeFilters = {
  allowActors: string[];
  ignoreActors: string[];
  ignoreMarker: string;
};

export type FieldMap = {
  key: string;
  id?: string;
  type?: string;
  actorId?: string;
  actorName?: string;
  at?: string;
  url?: string;
  summary?: string;
};

export type WebhookSourceConfig = IntakeFilters & {
  type: "webhook";
  signature: { header: string; prefix: string; secret: string };
  map: FieldMap;
};

export type JiraSourceConfig = IntakeFilters & {
  type: "jira";
  site: string;
  email?: string;
  token?: string;
  poll?: { intervalSeconds: number };
  webhookSecret?: string;
  // Changelog fields whose changes do not make an event, matched exactly as Jira names them.
  ignoreFields: string[];
};

export type SourceConfig = WebhookSourceConfig | JiraSourceConfig;

export type Config = {
  listen: { host: string; port: number };
  sources: Record<string, SourceConfig>;
};

type Json = Record<string, unknown>;

const mapFields = ["key", "id", "type", "actorId", "actorName", "at", "url", "summary"];
// The source name becomes the first part of a topic, which parseTopic restricts to this alphabet.
const sourceNamePattern = /^[a-z0-9-]+$/;
const defaultPollSeconds = 30;
// Below this the poller would spend Jira's rate limit for no gain, since the search index lags by seconds anyway.
const minimumPollSeconds = 5;

function asObject(value: unknown, key: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Json;
}

function rejectUnknownKeys(object: Json, allowed: string[], prefix: string): void {
  for (const field of Object.keys(object)) {
    if (!allowed.includes(field)) throw new Error(`${prefix}${field} is not a known setting`);
  }
}

function requiredText(object: Json, field: string, prefix: string): string {
  const value = object[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${prefix}${field} must be a non-empty string`);
  }
  return value;
}

// For settings where the empty string is a meaningful value.
function textOrEmpty(object: Json, field: string, prefix: string): string {
  const value = object[field] ?? "";
  if (typeof value !== "string") throw new Error(`${prefix}${field} must be a string`);
  return value;
}

function textList(object: Json, field: string, prefix: string): string[] {
  const value = object[field] ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`${prefix}${field} must be a list of non-empty strings`);
  }
  return value as string[];
}

function readMap(map: Json, prefix: string): FieldMap {
  const optional = Object.fromEntries(
    mapFields
      .filter((field) => field !== "key" && map[field] !== undefined)
      .map((field) => [field, requiredText(map, field, prefix)]),
  );
  return { key: requiredText(map, "key", prefix), ...optional };
}

function readFilters(source: Json, prefix: string): IntakeFilters {
  return {
    allowActors: textList(source, "allowActors", prefix),
    ignoreActors: textList(source, "ignoreActors", prefix),
    ignoreMarker: textOrEmpty(source, "ignoreMarker", prefix),
  };
}

function validateWebhookSource(source: Json, prefix: string): WebhookSourceConfig {
  rejectUnknownKeys(
    source,
    ["type", "signature", "map", "allowActors", "ignoreActors", "ignoreMarker"],
    prefix,
  );

  const signature = asObject(source.signature, `${prefix}signature`);
  rejectUnknownKeys(signature, ["header", "prefix", "secret"], `${prefix}signature.`);
  const map = asObject(source.map, `${prefix}map`);
  rejectUnknownKeys(map, mapFields, `${prefix}map.`);

  return {
    type: "webhook",
    signature: {
      header: requiredText(signature, "header", `${prefix}signature.`).toLowerCase(),
      prefix: textOrEmpty(signature, "prefix", `${prefix}signature.`),
      secret: requiredText(signature, "secret", `${prefix}signature.`),
    },
    map: readMap(map, `${prefix}map.`),
    ...readFilters(source, prefix),
  };
}

// Links in events are built from the site, so it must be a bare https origin.
function readSite(source: Json, prefix: string): string {
  const text = requiredText(source, "site", prefix);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${prefix}site must be an https address such as https://example.atlassian.net`);
  }
  const isBareOrigin = url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash && !url.username;
  if (!isBareOrigin) {
    throw new Error(`${prefix}site must be an https origin with no path, such as https://example.atlassian.net`);
  }
  return url.origin;
}

function readPoll(raw: unknown, prefix: string): { intervalSeconds: number } {
  const poll = asObject(raw, `${prefix}poll`);
  rejectUnknownKeys(poll, ["intervalSeconds"], `${prefix}poll.`);
  const intervalSeconds = poll.intervalSeconds ?? defaultPollSeconds;
  if (
    typeof intervalSeconds !== "number" ||
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < minimumPollSeconds
  ) {
    throw new Error(`${prefix}poll.intervalSeconds must be an integer of at least ${minimumPollSeconds}`);
  }
  return { intervalSeconds };
}

function validateJiraSource(source: Json, prefix: string): JiraSourceConfig {
  rejectUnknownKeys(
    source,
    ["type", "site", "email", "token", "poll", "webhookSecret", "ignoreFields", "allowActors", "ignoreActors", "ignoreMarker"],
    prefix,
  );
  if (source.poll === undefined && source.webhookSecret === undefined) {
    throw new Error(`${prefix}poll or ${prefix}webhookSecret is needed, or the source would never receive an event`);
  }

  const config: JiraSourceConfig = { type: "jira", site: readSite(source, prefix),
    ignoreFields: textList(source, "ignoreFields", prefix),
    ...readFilters(source, prefix),
  };
  if (source.poll !== undefined) {
    config.poll = readPoll(source.poll, prefix);
    config.email = requiredText(source, "email", prefix);
    config.token = requiredText(source, "token", prefix);
  }
  if (source.webhookSecret !== undefined) config.webhookSecret = requiredText(source, "webhookSecret", prefix);
  return config;
}

function validateSource(name: string, raw: unknown): SourceConfig {
  const prefix = `sources.${name}.`;
  if (!sourceNamePattern.test(name)) {
    throw new Error(`sources.${name} is not a valid source name, use lowercase letters, digits and hyphens`);
  }
  const source = asObject(raw, `sources.${name}`);
  if (source.type === "webhook") return validateWebhookSource(source, prefix);
  if (source.type === "jira") return validateJiraSource(source, prefix);
  throw new Error(`${prefix}type is ${JSON.stringify(source.type)}, expected "webhook" or "jira"`);
}

export function validateConfig(raw: unknown): Config {
  const root = asObject(raw, "config");
  rejectUnknownKeys(root, ["listen", "sources"], "");

  const listen = asObject(root.listen ?? {}, "listen");
  rejectUnknownKeys(listen, ["host", "port"], "listen.");
  const port = listen.port ?? 8377;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("listen.port must be an integer from 0 to 65535");
  }

  const sources = asObject(root.sources ?? {}, "sources");
  return {
    listen: { host: listen.host === undefined ? "127.0.0.1" : requiredText(listen, "host", "listen."), port },
    sources: Object.fromEntries(
      Object.entries(sources).map(([name, source]) => [name, validateSource(name, source)]),
    ),
  };
}

// A missing file means the defaults, so a broker can start before anything is configured.
export function loadConfig(file: string): Config {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return validateConfig({});
    throw error;
  }
  try {
    return validateConfig(JSON.parse(content));
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
}
