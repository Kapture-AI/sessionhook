import { setTimeout as sleep } from "node:timers/promises";
import type { NewEvent } from "../event.js";
import type { EventStore } from "../store.js";
import {
  changelogMayHideWindow,
  commentsAreCut,
  eventsInWindow,
  issueKeyPattern,
  type JiraComment,
  type JiraHistory,
  type JiraIssue,
} from "./jiraEvents.js";

// The search index lags a new comment by a couple of seconds, so each poll looks back this far
// and relies on event ids to drop what it has already seen.
const overlapMs = 60_000;
const pageSize = 100;
const requestTimeoutMs = 30_000;

// What tests replace to run the poller without the network or the wall clock.
export type JiraRuntime = { fetch?: typeof fetch; now?: () => number };

export type JiraPollerOptions = JiraRuntime & {
  name: string;
  site: string;
  email: string;
  token: string;
  intervalMs: number;
  ignoreFields: string[];
  store: EventStore;
  intake: (events: NewEvent[]) => void;
  log: (line: string) => void;
};

class JiraHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(`HTTP ${status}`);
  }
}

type SearchPage = { issues: JiraIssue[]; isLast: boolean; nextPageToken?: string };

function describeFailure(error: unknown): string {
  if (error instanceof JiraHttpError && (error.status === 401 || error.status === 403)) {
    return `${error.message}, the email or API token is wrong`;
  }
  return (error as Error).message;
}

// Owns the timer, the cursor and the requests for one Jira source in poll mode.
export class JiraPoller {
  private readonly authorization: string;
  private readonly fetchJira: typeof fetch;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly cursorKey: string;
  private readonly aborted = new AbortController();
  private readonly ignoredTopics = new Set<string>();
  private loop: Promise<void> | undefined;
  private stopped = false;
  private failing = false;
  private nextDelayMs: number;

  constructor(private readonly options: JiraPollerOptions) {
    this.authorization = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString("base64")}`;
    this.fetchJira = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.cursorKey = `poll-cursor:${options.name}`;
    this.nextDelayMs = options.intervalMs;
  }

  // Ticks run one after another because the next one is only scheduled once the last has finished.
  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.aborted.abort();
    await this.loop;
  }

  // One poll. It never throws, a failure is logged and leaves the cursor where it was.
  async pollOnce(): Promise<void> {
    this.nextDelayMs = this.options.intervalMs;
    const tickStart = this.now();
    try {
      const keys = this.subscribedKeys();
      if (keys.length > 0) {
        const events = await this.collectEvents(keys, this.cursor() - overlapMs);
        events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        if (events.length > 0) this.options.intake(events);
      }
      this.options.store.setState(this.cursorKey, String(tickStart));
      if (this.failing) {
        this.failing = false;
        this.options.log(`poll ${this.options.name}: recovered`);
      }
    } catch (error) {
      this.recordFailure(error);
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      await this.pollOnce();
      await this.pause(this.nextDelayMs);
    }
  }

  private async pause(milliseconds: number): Promise<void> {
    try {
      await sleep(milliseconds, undefined, { signal: this.aborted.signal });
    } catch {
      // Aborting is how stop() ends the wait, and the loop condition then ends the loop.
    }
  }

  private cursor(): number {
    const saved = Number(this.options.store.getState(this.cursorKey));
    return Number.isFinite(saved) && saved > 0 ? saved : this.startedAt;
  }

  // Keys go into the JQL, so only text shaped like a ticket key may pass.
  private subscribedKeys(): string[] {
    const prefix = `${this.options.name}:`;
    const keys: string[] = [];
    for (const topic of this.options.store.subscribedTopics()) {
      if (!topic.startsWith(prefix)) continue;
      const key = topic.slice(prefix.length);
      if (issueKeyPattern.test(key)) {
        keys.push(key);
      } else if (!this.ignoredTopics.has(topic)) {
        this.ignoredTopics.add(topic);
        this.options.log(`poll ${this.options.name}: "${topic}" can never match, a Jira key looks like PROJ-123`);
      }
    }
    return keys;
  }

  private async collectEvents(keys: string[], windowStart: number): Promise<NewEvent[]> {
    const events: NewEvent[] = [];
    for (const issue of await this.search(keys, windowStart)) {
      const origin = { source: this.options.name, site: this.options.site, key: issue.key };
      const comments = commentsAreCut(issue) ? await this.newestComments(issue.key) : issue.fields.comment?.comments ?? [];
      const histories = changelogMayHideWindow(issue, windowStart)
        ? await this.newestHistories(issue.key, issue.changelog!.total)
        : issue.changelog?.histories ?? [];
      events.push(...eventsInWindow(origin, comments, histories, windowStart, this.options.ignoreFields));
    }
    return events;
  }

  private async search(keys: string[], windowStart: number): Promise<JiraIssue[]> {
    // Unquoted epoch milliseconds are the only form of `updated` that is exact and independent of time zone.
    const jql = `key in (${keys.join(",")}) AND updated >= ${Math.floor(windowStart)}`;
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.request<SearchPage>("/rest/api/3/search/jql", {
        jql,
        fields: ["comment", "updated", "summary", "status"],
        expand: "changelog",
        maxResults: pageSize,
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      });
      issues.push(...page.issues);
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
    } while (nextPageToken !== undefined);
    return issues;
  }

  private async newestComments(key: string): Promise<JiraComment[]> {
    const query = `orderBy=-created&maxResults=${pageSize}`;
    const page = await this.request<{ comments: JiraComment[] }>(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?${query}`);
    return page.comments;
  }

  // The endpoint lists oldest first and ignores orderBy, so the newest entries are at the end.
  private async newestHistories(key: string, total: number): Promise<JiraHistory[]> {
    const query = `startAt=${Math.max(0, total - pageSize)}&maxResults=${pageSize}`;
    const page = await this.request<{ values: JiraHistory[] }>(`/rest/api/3/issue/${encodeURIComponent(key)}/changelog?${query}`);
    return page.values;
  }

  // A body means POST, no body means GET.
  private async request<T>(path: string, body?: object): Promise<T> {
    const response = await this.fetchJira(`${this.options.site}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: this.authorization,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([this.aborted.signal, AbortSignal.timeout(requestTimeoutMs)]),
    });
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new JiraHttpError(response.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    }
    try {
      return (await response.json()) as T;
    } catch {
      // The parser's message can quote the start of the response, which must not reach the log.
      throw new Error("the response was not JSON");
    }
  }

  private recordFailure(error: unknown): void {
    if (this.stopped) return;
    if (error instanceof JiraHttpError && error.retryAfterSeconds !== undefined) {
      this.nextDelayMs = Math.max(this.options.intervalMs, error.retryAfterSeconds * 1000);
    }
    if (this.failing) return;
    this.failing = true;
    this.options.log(`poll ${this.options.name}: failed, ${describeFailure(error)}, it keeps retrying and logs again when it recovers`);
  }
}
