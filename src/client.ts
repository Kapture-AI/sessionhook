import { request } from "node:http";
import type { EventRecord } from "./event.js";
import type { SubscriberStatus } from "./store.js";

// The broker answered, with a status other than 200.
export class BrokerRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Nothing answers on the socket, or the connection broke while a request was open.
export class BrokerNotRunningError extends Error {
  constructor() {
    super("the broker is not running, start it with `sessionhook serve`");
  }
}

// A broker that stops mid-request resets the connection instead of refusing it.
const brokerGoneCodes = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]);

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

  // Holds the request open for up to waitSeconds when nothing is unread. Aborting
  // the signal ends the request early and rejects with an AbortError.
  async events(subscriber: string, waitSeconds: number, signal?: AbortSignal): Promise<EventRecord[]> {
    const query = new URLSearchParams({ subscriber, wait: String(waitSeconds) });
    const reply = await this.call("GET", `/events?${query}`, undefined, signal);
    return reply.events as EventRecord[];
  }

  async ack(subscriber: string, seq: number): Promise<void> {
    await this.call("POST", "/ack", { subscriber, seq });
  }

  async rewind(subscriber: string, seq: number): Promise<number> {
    const reply = await this.call("POST", "/rewind", { subscriber, seq });
    return reply.unread as number;
  }

  private call(method: string, path: string, body?: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const fail = (error: NodeJS.ErrnoException) =>
        reject(brokerGoneCodes.has(error.code ?? "") ? new BrokerNotRunningError() : error);
      const outgoing = request(
        { socketPath: this.socketPath, method, path, agent: false, signal },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", fail);
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(text);
            } catch {
              return reject(new Error(`the broker sent an unreadable reply (status ${response.statusCode})`));
            }
            if (response.statusCode !== 200) {
              const message = String(parsed.error ?? `the broker answered ${response.statusCode}`);
              return reject(new BrokerRequestError(response.statusCode ?? 0, message));
            }
            resolve(parsed);
          });
        },
      );
      outgoing.on("error", fail);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
}
