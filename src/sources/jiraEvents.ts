import type { NewEvent } from "../event.js";
import { BadPayloadError } from "../source.js";

const summaryLimit = 2000;
export const issueKeyPattern = /^[A-Z][A-Z0-9_]*-[0-9]+$/;

type JiraUser = { accountId?: string; displayName?: string };

export type JiraComment = {
  id: string;
  author?: JiraUser;
  updateAuthor?: JiraUser;
  // Plain text from a webhook, an Atlassian Document Format tree from the REST API.
  body: unknown;
  created: string;
  updated: string;
};

export type JiraHistory = {
  id: string;
  author?: JiraUser;
  created: string;
  items: Array<{ field: string; fromString?: string | null; toString?: string | null }>;
};

export type JiraIssue = {
  key: string;
  fields: {
    comment?: { comments: JiraComment[]; total: number };
  };
  changelog?: { histories: JiraHistory[]; total: number };
};

// Where an event came from, which fixes its id prefix, topic and links.
export type EventOrigin = { source: string; site: string; key: string };

type AdfNode = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: AdfNode[] };

function render(node: AdfNode): string {
  const children = () => (node.content ?? []).map(render).join("");
  switch (node.type) {
    case "text":
      return node.text ?? "";
    case "hardBreak":
      return "\n";
    case "mention":
      return String(node.attrs?.text ?? "");
    case "emoji":
      return String(node.attrs?.text ?? node.attrs?.shortName ?? "");
    case "inlineCard":
      return String(node.attrs?.url ?? "");
    case "paragraph":
    case "heading":
    case "codeBlock":
      return `${children()}\n`;
    case "listItem":
      return `- ${children().trimEnd()}\n`;
    default:
      return children();
  }
}

export function adfToText(document: unknown): string {
  return render(document as AdfNode).trim();
}

function bodyText(body: unknown): string {
  const text = typeof body === "string" ? body.trim() : adfToText(body);
  return text.slice(0, summaryLimit);
}

// Jira writes offsets as +0400, which not every date parser accepts.
export function parseJiraTime(text: string): number {
  const milliseconds = Date.parse(text.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  if (Number.isNaN(milliseconds)) throw new BadPayloadError(`"${text}" is not a time`);
  return milliseconds;
}

function actorOf(user: JiraUser | undefined): NewEvent["actor"] {
  return { id: user?.accountId ?? "", name: user?.displayName ?? "" };
}

function commentUrl(origin: EventOrigin, comment: JiraComment): string {
  return `${origin.site}/browse/${origin.key}?focusedCommentId=${comment.id}`;
}

export function commentCreatedEvent(origin: EventOrigin, comment: JiraComment): NewEvent {
  return {
    id: `${origin.source}:comment:${comment.id}`,
    topic: `${origin.source}:${origin.key}`,
    type: "comment_created",
    actor: actorOf(comment.author),
    at: new Date(parseJiraTime(comment.created)).toISOString(),
    url: commentUrl(origin, comment),
    summary: bodyText(comment.body),
  };
}

// The update time is part of the id so that each edit is its own event.
export function commentUpdatedEvent(origin: EventOrigin, comment: JiraComment): NewEvent {
  const updated = parseJiraTime(comment.updated);
  return {
    id: `${origin.source}:comment:${comment.id}:updated:${updated}`,
    topic: `${origin.source}:${origin.key}`,
    type: "comment_updated",
    actor: actorOf(comment.updateAuthor ?? comment.author),
    at: new Date(updated).toISOString(),
    url: commentUrl(origin, comment),
    summary: bodyText(comment.body),
  };
}

// An entry whose items are all ignored produces no event.
export function historyEvent(
  origin: EventOrigin,
  history: JiraHistory,
  ignoreFields: string[],
): NewEvent | undefined {
  const items = history.items.filter((item) => !ignoreFields.includes(item.field));
  if (items.length === 0) return undefined;
  const lines = items.map(
    (item) => `${item.field}: ${item.fromString || "none"} -> ${item.toString || "none"}`,
  );
  return {
    id: `${origin.source}:changelog:${history.id}`,
    topic: `${origin.source}:${origin.key}`,
    type: "issue_updated",
    actor: actorOf(history.author),
    at: new Date(parseJiraTime(history.created)).toISOString(),
    url: `${origin.site}/browse/${origin.key}`,
    summary: lines.join("\n").slice(0, summaryLimit),
  };
}

// Inline comments are the oldest 20, so a cut always hides the newest ones.
export function commentsAreCut(issue: JiraIssue): boolean {
  const comment = issue.fields.comment;
  return comment !== undefined && comment.total > comment.comments.length;
}

// Inline history is the newest 40, so what is cut is older than everything shown
// and can only fall inside the window when the oldest shown entry already does.
export function changelogMayHideWindow(issue: JiraIssue, windowStart: number): boolean {
  const changelog = issue.changelog;
  if (changelog === undefined || changelog.total <= changelog.histories.length) return false;
  const oldestShown = changelog.histories.at(-1);
  return oldestShown !== undefined && parseJiraTime(oldestShown.created) >= windowStart;
}

// The search returns an issue's whole recent past, so only what happened since windowStart is new.
export function eventsInWindow(
  origin: EventOrigin,
  comments: JiraComment[],
  histories: JiraHistory[],
  windowStart: number,
  ignoreFields: string[],
): NewEvent[] {
  const events: NewEvent[] = [];
  for (const comment of comments) {
    if (parseJiraTime(comment.created) >= windowStart) events.push(commentCreatedEvent(origin, comment));
    const edited = parseJiraTime(comment.updated) !== parseJiraTime(comment.created);
    if (edited && parseJiraTime(comment.updated) >= windowStart) events.push(commentUpdatedEvent(origin, comment));
  }
  for (const history of histories) {
    if (parseJiraTime(history.created) < windowStart) continue;
    const event = historyEvent(origin, history, ignoreFields);
    if (event) events.push(event);
  }
  return events;
}
