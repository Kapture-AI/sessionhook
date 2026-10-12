import { request } from "node:http";
import type { EventRecord } from "./event.js";
import type { SubscriberStatus } from "./store.js";

const notRunning = "the broker is not running, start it with `sessionhook serve`";

export class BrokerClient {
  constructor(private readonly socketPath: string) {}

  async subscribe(subscriber: string, topic: string): Promise<void> {
    await this.call("POST", "/subscribe", { subscriber, topic });
  }

  async unsubscribe(subscriber: string, topic: string): Promise<boolean> {
    const reply = await this.call("POST", "/unsubscribe", { subscriber, topic });
    return reply.removed as boolean;
  }

  async status(): Promise<SubscriberStatus[]> {
    const reply = await this.call("GET", "/status");
    return reply.subscribers as SubscriberStatus[];
  }

  // Holds the request open for up to waitSeconds when nothing is unread.
  async events(subscriber: string, waitSeconds: number): Promise<EventRecord[]> {
    const query = new URLSearchParams({ subscriber, wait: String(waitSeconds) });
    const reply = await this.call("GET", `/events?${query}`);
    return reply.events as EventRecord[];
  }

  async ack(subscriber: string, seq: number): Promise<void> {
    await this.call("POST", "/ack", { subscriber, seq });
  }

  async rewind(subscriber: string, seq: number): Promise<number> {
    const reply = await this.call("POST", "/rewind", { subscriber, seq });
    return reply.unread as number;
  }

  private call(method: string, path: string, body?: object): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const outgoing = request(
        { socketPath: this.socketPath, method, path, agent: false },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(text);
            } catch {
              return reject(new Error(`the broker sent an unreadable reply (status ${response.statusCode})`));
            }
            if (response.statusCode !== 200) {
              return reject(new Error(String(parsed.error ?? `the broker answered ${response.statusCode}`)));
            }
            resolve(parsed);
          });
        },
      );
      outgoing.on("error", (error: NodeJS.ErrnoException) => {
        const missing = error.code === "ENOENT" || error.code === "ECONNREFUSED";
        reject(missing ? new Error(notRunning) : error);
      });
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
}
