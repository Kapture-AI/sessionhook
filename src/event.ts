export type EventRecord = {
  seq: number;
  id: string;
  topic: string;
  type: string;
  actor: { id: string; name: string };
  at: string;
  url: string;
  summary: string;
};

export type NewEvent = Omit<EventRecord, "seq">;

export type Topic = { source: string; key: string };

// The key may contain colons and slashes, so only the first colon separates the parts.
const topicPattern = /^([a-z0-9-]+):(.+)$/;

export function parseTopic(topic: string): Topic {
  const match = topicPattern.exec(topic);
  if (!match) {
    throw new Error(
      `invalid topic "${topic}", expected source:key with a lowercase source such as jira:PROJ-123`,
    );
  }
  return { source: match[1]!, key: match[2]! };
}

// The text a session reads, so each event is a short block with the summary last.
export function formatEvent(event: EventRecord): string {
  const byline = [event.actor.name && `by ${event.actor.name}`, event.at].filter(Boolean).join(" at ");
  return [`#${event.seq} ${event.topic} ${event.type}`, byline, event.url, event.summary]
    .filter((line) => line !== "")
    .join("\n");
}
