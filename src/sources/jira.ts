import type { JiraSourceConfig } from "../config.js";
import type { NewEvent } from "../event.js";
import { hasValidSignature } from "../signature.js";
import { BadPayloadError, type InboundRequest, type Source } from "../source.js";
import {
  commentCreatedEvent,
  commentUpdatedEvent,
  historyEvent,
  issueKeyPattern,
  type EventOrigin,
  type JiraComment,
  type JiraHistory,
} from "./jiraEvents.js";

type Json = Record<string, unknown>;

function objectAt(parent: Json, field: string): Json {
  const value = parent[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadPayloadError(`the body has no object at "${field}"`);
  }
  return value as Json;
}

function idAt(parent: Json, field: string): string {
  const value = parent[field];
  if ((typeof value !== "string" && typeof value !== "number") || value === "") {
    throw new BadPayloadError(`the body has no id at "${field}"`);
  }
  return String(value);
}

function commentFrom(body: Json): JiraComment {
  const comment = objectAt(body, "comment");
  if (typeof comment.created !== "string" || typeof comment.updated !== "string") {
    throw new BadPayloadError("the comment has no created or updated time");
  }
  return { ...comment, id: idAt(comment, "id") } as JiraComment;
}

// A webhook delivers only the changelog's id and items, so the time is the delivery's own.
function historyFrom(body: Json): JiraHistory | undefined {
  const changelog = body.changelog;
  if (typeof changelog !== "object" || changelog === null) return undefined;
  const { items } = changelog as Json;
  if (!Array.isArray(items) || items.length === 0) return undefined;
  if (typeof body.timestamp !== "number") throw new BadPayloadError("the body has no timestamp");
  return {
    id: idAt(changelog as Json, "id"),
    author: body.user as JiraHistory["author"],
    created: new Date(body.timestamp).toISOString(),
    items: items as JiraHistory["items"],
  };
}

export class JiraSource implements Source {
  constructor(
    private readonly name: string,
    private readonly config: JiraSourceConfig,
    // Without a secret the source has no webhook mode and rejects every request.
    private readonly webhookSecret: string | undefined,
  ) {}

  authenticate(request: InboundRequest): boolean {
    if (this.webhookSecret === undefined) return false;
    return hasValidSignature(request.headers["x-hub-signature"], "sha256=", this.webhookSecret, request.rawBody);
  }

  // Event kinds the source does not translate produce no events and are still answered 200,
  // so Jira does not retry them.
  parse(request: InboundRequest): NewEvent[] {
    let body: Json;
    try {
      body = JSON.parse(request.rawBody.toString("utf8")) as Json;
    } catch {
      throw new BadPayloadError("the body is not JSON");
    }
    switch (body.webhookEvent) {
      case "comment_created":
        return [commentCreatedEvent(this.originOf(body), commentFrom(body))];
      case "comment_updated":
        return [commentUpdatedEvent(this.originOf(body), commentFrom(body))];
      case "jira:issue_updated": {
        const history = historyFrom(body);
        return history === undefined ? [] : [historyEvent(this.originOf(body), history)];
      }
      default:
        return [];
    }
  }

  private originOf(body: Json): EventOrigin {
    const key = objectAt(body, "issue").key;
    if (typeof key !== "string" || !issueKeyPattern.test(key)) {
      throw new BadPayloadError("the body has no valid issue key");
    }
    return { source: this.name, site: this.config.site, key };
  }
}
