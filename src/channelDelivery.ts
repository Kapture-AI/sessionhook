import { BrokerNotRunningError, BrokerRequestError, type BrokerClient } from "./client.js";
import { formatEvent, type EventRecord } from "./event.js";

const pollSeconds = 25;

export type ChannelMessage = { content: string; meta: Record<string, string> };

export type RetryDelays = {
  // Wait before asking again when the broker does not know the subscriber yet.
  notSubscribedMs: number;
  // The wait after the first failure, doubled after each further one up to the maximum.
  failureInitialMs: number;
  failureMaxMs: number;
};

export const defaultRetryDelays: RetryDelays = {
  notSubscribedMs: 5000,
  failureInitialMs: 1000,
  failureMaxMs: 15000,
};

export type ChannelDeliveryOptions = {
  client: BrokerClient;
  name: string;
  send: (message: ChannelMessage) => Promise<void>;
  log: (line: string) => void;
  delays?: RetryDelays;
};

// Meta keys must be identifiers, and a key with no value would only add noise to the tag.
export function channelMessage(event: EventRecord): ChannelMessage {
  const fields = {
    topic: event.topic,
    event_type: event.type,
    seq: String(event.seq),
    actor: event.actor.name || event.actor.id,
    at: event.at,
    url: event.url,
  };
  const meta = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== ""));
  return { content: formatEvent(event), meta };
}

// Reads the subscriber's unread events from the broker and hands each to `send`.
export class ChannelDelivery {
  private readonly delays: RetryDelays;
  private failureDelayMs: number;
  private brokerDown = false;
  private endSleep: (() => void) | undefined;

  constructor(private readonly options: ChannelDeliveryOptions) {
    this.delays = options.delays ?? defaultRetryDelays;
    this.failureDelayMs = this.delays.failureInitialMs;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.deliverUnread(signal);
      } catch (error) {
        if (signal.aborted) return;
        await this.waitAfter(error, signal);
      }
    }
  }

  // A new subscription makes an unknown subscriber known, so there is no reason to wait out the delay.
  retryNow(): void {
    this.endSleep?.();
  }

  private async deliverUnread(signal: AbortSignal): Promise<void> {
    const { client, name, send } = this.options;
    const events = await client.events(name, pollSeconds, signal);
    this.brokerAnswered();
    for (const event of events) {
      await send(channelMessage(event));
      // The cursor moves only after the notification is written, so a crash in between
      // delivers the event again instead of losing it.
      await client.ack(name, event.seq);
    }
  }

  private async waitAfter(error: unknown, signal: AbortSignal): Promise<void> {
    if (error instanceof BrokerRequestError && error.status === 404) {
      this.brokerAnswered();
      return this.sleep(this.delays.notSubscribedMs, signal);
    }
    if (error instanceof BrokerNotRunningError) {
      if (!this.brokerDown) this.options.log("the broker is not running, will keep trying until it is back");
      this.brokerDown = true;
    } else {
      this.options.log(`delivery failed, will retry: ${(error as Error).message}`);
    }
    const delay = this.failureDelayMs;
    this.failureDelayMs = Math.min(delay * 2, this.delays.failureMaxMs);
    return this.sleep(delay, signal);
  }

  private brokerAnswered(): void {
    if (this.brokerDown) this.options.log("the broker is back, delivery resumed");
    this.brokerDown = false;
    this.failureDelayMs = this.delays.failureInitialMs;
  }

  private sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const end = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", end);
        this.endSleep = undefined;
        resolve();
      };
      const timer = setTimeout(end, milliseconds);
      signal.addEventListener("abort", end, { once: true });
      this.endSleep = end;
    });
  }
}
