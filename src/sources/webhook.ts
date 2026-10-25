import { createHash } from "node:crypto";
import type { WebhookSourceConfig } from "../config.js";
import { parseTopic, type NewEvent } from "../event.js";
import { hasValidSignature } from "../signature.js";
import { BadPayloadError, type InboundRequest, type Source } from "../source.js";

const summaryLimit = 2000;

function valueAt(body: unknown, path: string): string | undefined {
  let current = body;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current === "string" || typeof current === "number" || typeof current === "boolean") {
    return String(current);
  }
  return undefined;
}

// True when the body's changelog.items is a non-empty list whose every field is ignored.
function changesOnlyIgnoredFields(body: unknown, ignoreFields: string[]): boolean {
  if (ignoreFields.length === 0 || typeof body !== "object" || body === null) return false;
  const changelog = (body as Record<string, unknown>).changelog;
  if (typeof changelog !== "object" || changelog === null) return false;
  const items = (changelog as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every((item) => {
    const field = typeof item === "object" && item !== null ? (item as Record<string, unknown>).field : undefined;
    return typeof field === "string" && ignoreFields.includes(field);
  });
}

function isoTime(value: string | undefined, fallback: Date): string {
  const parsed = value === undefined ? fallback : new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

export class WebhookSource implements Source {
  constructor(
    private readonly name: string,
    private readonly config: WebhookSourceConfig,
    private readonly secret: string,
  ) {}

  authenticate(request: InboundRequest): boolean {
    const { header, prefix } = this.config.signature;
    return hasValidSignature(request.headers[header], prefix, this.secret, request.rawBody);
  }

  parse(request: InboundRequest): NewEvent[] {
    const receivedAt = new Date();
    let body: unknown;
    try {
      body = JSON.parse(request.rawBody.toString("utf8"));
    } catch {
      throw new BadPayloadError("the body is not JSON");
    }
    const { map } = this.config;
    const read = (path: string | undefined) => (path === undefined ? undefined : valueAt(body, path));

    const key = read(map.key);
    if (!key) throw new BadPayloadError(`the body has no value at "${map.key}"`);
    const topic = `${this.name}:${key}`;
    try {
      parseTopic(topic);
    } catch {
      throw new BadPayloadError(`the value at "${map.key}" cannot be used in a topic`);
    }
    if (changesOnlyIgnoredFields(body, this.config.ignoreFields ?? [])) return [];

    const mappedId = read(map.id);
    const id = mappedId
      ? `${this.name}:${mappedId}`
      : `${this.name}:${createHash("sha256").update(request.rawBody).digest("hex")}`;

    return [
      {
        id,
        topic,
        type: read(map.type) ?? "event",
        actor: { id: read(map.actorId) ?? "", name: read(map.actorName) ?? "" },
        at: isoTime(read(map.at), receivedAt),
        url: read(map.url) ?? "",
        summary: (read(map.summary) ?? "").slice(0, summaryLimit),
      },
    ];
  }
}
