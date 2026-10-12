import { DatabaseSync } from "node:sqlite";
import type { EventRecord, NewEvent } from "./event.js";

export type SubscriberStatus = {
  name: string;
  topics: string[];
  unread: number;
  cursor: number;
  lastSeen: string;
};

type EventRow = {
  seq: number;
  id: string;
  topic: string;
  type: string;
  actor_id: string;
  actor_name: string;
  at: string;
  url: string;
  summary: string;
};

// A subscription only yields events that arrived after it was made, so the
// subscriber's cursor and the subscription's since_seq must both be passed.
const unreadFrom = `
  FROM events e
  JOIN subscriptions s ON s.subscriber = :name AND s.topic = e.topic AND e.seq > s.since_seq
  WHERE e.seq > (SELECT cursor FROM subscribers WHERE name = :name)`;

function toRecord(row: EventRow): EventRecord {
  return {
    seq: row.seq,
    id: row.id,
    topic: row.topic,
    type: row.type,
    actor: { id: row.actor_id, name: row.actor_name },
    at: row.at,
    url: row.url,
    summary: row.summary,
  };
}

// Only the broker process opens the database, and every call here is
// synchronous, so no two calls interleave and no transactions are needed.
export class EventStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        topic TEXT NOT NULL,
        type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        at TEXT NOT NULL,
        url TEXT NOT NULL,
        summary TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscribers (
        name TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL,
        last_seen TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        subscriber TEXT NOT NULL,
        topic TEXT NOT NULL,
        since_seq INTEGER NOT NULL,
        PRIMARY KEY (subscriber, topic)
      );
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // Returns undefined when the id is already stored, which is a duplicate delivery and not an error.
  append(event: NewEvent): EventRecord | undefined {
    // Checked first because a conflicting INSERT still consumes a sequence number, which leaves gaps.
    if (this.db.prepare("SELECT 1 FROM events WHERE id = ?").get(event.id)) return undefined;
    const row = this.db
      .prepare(
        `INSERT INTO events (id, topic, type, actor_id, actor_name, at, url, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        event.id,
        event.topic,
        event.type,
        event.actor.id,
        event.actor.name,
        event.at,
        event.url,
        event.summary,
      );
    return row ? toRecord(row as EventRow) : undefined;
  }

  subscribe(name: string, topic: string): void {
    const latest = this.latestSeq();
    this.db
      .prepare("INSERT OR IGNORE INTO subscribers (name, cursor, last_seen) VALUES (?, ?, ?)")
      .run(name, latest, new Date().toISOString());
    this.db
      .prepare("INSERT OR IGNORE INTO subscriptions (subscriber, topic, since_seq) VALUES (?, ?, ?)")
      .run(name, topic, latest);
  }

  unsubscribe(name: string, topic: string): boolean {
    const { changes } = this.db
      .prepare("DELETE FROM subscriptions WHERE subscriber = ? AND topic = ?")
      .run(name, topic);
    return changes > 0;
  }

  hasSubscriber(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM subscribers WHERE name = ?").get(name) !== undefined;
  }

  touch(name: string): void {
    this.db
      .prepare("UPDATE subscribers SET last_seen = ? WHERE name = ?")
      .run(new Date().toISOString(), name);
  }

  unread(name: string, limit: number): EventRecord[] {
    const rows = this.db
      .prepare(`SELECT e.* ${unreadFrom} ORDER BY e.seq LIMIT :limit`)
      .all({ name, limit });
    return rows.map((row) => toRecord(row as EventRow));
  }

  unreadCount(name: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS total ${unreadFrom}`).get({ name });
    return Number(row!.total);
  }

  ack(name: string, seq: number): void {
    this.db.prepare("UPDATE subscribers SET cursor = MAX(cursor, ?) WHERE name = ?").run(seq, name);
  }

  rewind(name: string, seq: number): void {
    this.db.prepare("UPDATE subscribers SET cursor = MIN(cursor, ?) WHERE name = ?").run(seq - 1, name);
  }

  status(): SubscriberStatus[] {
    const subscribers = this.db
      .prepare("SELECT name, cursor, last_seen FROM subscribers ORDER BY name")
      .all();
    return subscribers.map((row) => {
      const name = String(row.name);
      const topics = this.db
        .prepare("SELECT topic FROM subscriptions WHERE subscriber = ? ORDER BY topic")
        .all(name)
        .map((topicRow) => String(topicRow.topic));
      return {
        name,
        topics,
        unread: this.unreadCount(name),
        cursor: Number(row.cursor),
        lastSeen: String(row.last_seen),
      };
    });
  }

  subscribedTopics(): string[] {
    return this.db
      .prepare("SELECT DISTINCT topic FROM subscriptions ORDER BY topic")
      .all()
      .map((row) => String(row.topic));
  }

  // Small values the broker keeps between runs, such as how far a poller has read.
  getState(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM state WHERE key = ?").get(key);
    return row === undefined ? undefined : String(row.value);
  }

  setState(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private latestSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS latest FROM events").get();
    return Number(row!.latest);
  }
}
