import { chmodSync } from "node:fs";
import type { Server } from "node:http";
import type { Config } from "./config.js";
import type { NewEvent, EventRecord } from "./event.js";
import { droppingRule } from "./filters.js";
import { createWebhookServer } from "./listener.js";
import { claimSocketPath, createLocalApiServer } from "./localApi.js";
import { ensureStateDir, type Paths } from "./paths.js";
import type { Source } from "./source.js";
import { EventStore } from "./store.js";

export type IntakeOutcome = "stored" | "duplicate" | "filtered";

export type BrokerOptions = {
  paths: Paths;
  config: Config;
  sources: Record<string, Source>;
  log: (line: string) => void;
};

function listening(server: Server, listen: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
    listen();
  });
}

function closed(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export class Broker {
  readonly store: EventStore;
  private readonly webhookServer: Server;
  private readonly localApiServer: Server;
  private readonly readers = new Set<() => void>();
  private stopping = false;

  private constructor(
    private readonly options: BrokerOptions,
    store: EventStore,
  ) {
    this.store = store;
    this.webhookServer = createWebhookServer(this, options.sources, options.log);
    this.localApiServer = createLocalApiServer(this, options.log);
  }

  static async start(options: BrokerOptions): Promise<Broker> {
    ensureStateDir(options.paths);
    await claimSocketPath(options.paths.socketFile);
    const broker = new Broker(options, new EventStore(options.paths.databaseFile));
    try {
      await broker.listen();
    } catch (error) {
      await broker.stop();
      throw error;
    }
    return broker;
  }

  // The port the webhook listener is bound to, which differs from the configured one when that is 0.
  get webhookPort(): number {
    const address = this.webhookServer.address();
    if (address === null || typeof address === "string") throw new Error("the webhook listener is not running");
    return address.port;
  }

  intake(sourceName: string, events: NewEvent[]): IntakeOutcome[] {
    const filters = this.options.config.sources[sourceName]!;
    try {
      return events.map((event) => {
        const rule = droppingRule(event, filters);
        if (rule) {
          this.options.log(`filtered ${event.topic} by ${rule}`);
          return "filtered";
        }
        const stored = this.store.append(event);
        if (!stored) {
          this.options.log(`duplicate ${event.topic} id=${JSON.stringify(event.id)}`);
          return "duplicate";
        }
        this.options.log(`stored ${stored.topic} seq=${stored.seq}`);
        return "stored";
      });
    } finally {
      this.wakeReaders();
    }
  }

  // Returns the subscriber's unread events at once, or waits until some arrive,
  // the wait runs out or the caller aborts. The result may be empty.
  async waitForUnread(
    subscriber: string,
    limit: number,
    waitSeconds: number,
    aborted: AbortSignal,
  ): Promise<EventRecord[]> {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const events = this.store.unread(subscriber, limit);
      const remaining = deadline - Date.now();
      if (events.length > 0 || remaining <= 0 || aborted.aborted || this.stopping) return events;
      await this.nextWake(remaining, aborted);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wakeReaders();
    // Lets the woken long-polls write their empty replies before the connections are cut.
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all([closed(this.webhookServer), closed(this.localApiServer)]);
    this.store.close();
  }

  private async listen(): Promise<void> {
    const { host, port } = this.options.config.listen;
    await listening(this.webhookServer, () => this.webhookServer.listen(port, host));
    const { socketFile } = this.options.paths;
    await listening(this.localApiServer, () => this.localApiServer.listen(socketFile));
    chmodSync(socketFile, 0o600);
    const names = Object.keys(this.options.sources).join(", ") || "none";
    this.options.log(`webhook listener on http://${host}:${this.webhookPort}, sources: ${names}`);
    this.options.log(`local API on ${socketFile}`);
  }

  private nextWake(milliseconds: number, aborted: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.readers.delete(wake);
        aborted.removeEventListener("abort", wake);
        resolve();
      };
      const timer = setTimeout(wake, milliseconds);
      this.readers.add(wake);
      aborted.addEventListener("abort", wake, { once: true });
    });
  }

  private wakeReaders(): void {
    for (const wake of [...this.readers]) wake();
  }
}
