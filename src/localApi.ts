import { existsSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Broker } from "./broker.js";
import { parseTopic } from "./event.js";
import { checkSubscriberName } from "./subscriber.js";

const bodyLimit = 64 * 1024;
const defaultLimit = 100;
const maxLimit = 1000;
const maxWaitSeconds = 120;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function reply(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > bodyLimit) throw new ApiError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "the body is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "the body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function validated<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    throw new ApiError(400, (error as Error).message);
  }
}

function subscriberFrom(body: Record<string, unknown>): string {
  if (typeof body.subscriber !== "string") throw new ApiError(400, "subscriber must be a string");
  const name = body.subscriber;
  return validated(() => checkSubscriberName(name));
}

function topicFrom(body: Record<string, unknown>): string {
  if (typeof body.topic !== "string") throw new ApiError(400, "topic must be a string");
  const topic = body.topic;
  validated(() => parseTopic(topic));
  return topic;
}

function seqFrom(body: Record<string, unknown>): number {
  if (typeof body.seq !== "number" || !Number.isInteger(body.seq) || body.seq < 0) {
    throw new ApiError(400, "seq must be a non-negative integer");
  }
  return body.seq;
}

function subscriberParam(url: URL): string {
  const name = url.searchParams.get("subscriber");
  if (name === null) throw new ApiError(400, "subscriber is required");
  return validated(() => checkSubscriberName(name));
}

function numberParam(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new ApiError(400, `${name} must be a non-negative number`);
  return Math.min(value, max);
}

function knownSubscriber(broker: Broker, name: string): string {
  if (!broker.store.hasSubscriber(name)) {
    throw new ApiError(404, `unknown subscriber "${name}", subscribe to a topic first`);
  }
  return name;
}

export function createLocalApiServer(broker: Broker, log: (line: string) => void): Server {
  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<object> {
    const endpoint = `${request.method} ${url.pathname}`;
    switch (endpoint) {
      case "POST /subscribe": {
        const body = await readJson(request);
        broker.store.subscribe(subscriberFrom(body), topicFrom(body));
        return { ok: true };
      }
      case "POST /unsubscribe": {
        const body = await readJson(request);
        return { removed: broker.store.unsubscribe(subscriberFrom(body), topicFrom(body)) };
      }
      case "GET /status":
        return { subscribers: broker.store.status() };
      case "GET /events": {
        const name = knownSubscriber(broker, subscriberParam(url));
        broker.store.touch(name);
        const limit = numberParam(url.searchParams, "limit", defaultLimit, maxLimit);
        const wait = numberParam(url.searchParams, "wait", 0, maxWaitSeconds);
        const gone = new AbortController();
        response.on("close", () => gone.abort());
        const events = await broker.waitForUnread(name, limit, wait, gone.signal);
        broker.store.touch(name);
        return { events };
      }
      case "POST /ack": {
        const body = await readJson(request);
        broker.store.ack(knownSubscriber(broker, subscriberFrom(body)), seqFrom(body));
        return { ok: true };
      }
      case "POST /rewind": {
        const body = await readJson(request);
        const name = knownSubscriber(broker, subscriberFrom(body));
        broker.store.rewind(name, seqFrom(body));
        return { unread: broker.store.unreadCount(name) };
      }
      default:
        throw new ApiError(404, "not found");
    }
  }

  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://broker.local");
    route(request, response, url).then(
      (body) => reply(response, 200, body),
      (error: unknown) => {
        if (error instanceof ApiError) return reply(response, error.status, { error: error.message });
        log(`local API failed: ${(error as Error).message}`);
        reply(response, 500, { error: "internal error" });
      },
    );
  });
}

// The longest socket path sun_path holds is 104 bytes on macOS and 108 on Linux.
const maxSocketPathBytes = 103;

// Refuses when a broker already answers on the socket, and removes a leftover
// file that nothing answers on, such as one left behind by a crashed broker.
export async function claimSocketPath(file: string): Promise<void> {
  if (Buffer.byteLength(file) > maxSocketPathBytes) {
    throw new Error(`the socket path ${file} is too long, set SESSIONHOOK_STATE_DIR to a shorter directory`);
  }
  if (!existsSync(file)) return;
  const probe = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
    const connection = connect(file);
    connection.once("connect", () => {
      connection.destroy();
      resolve(undefined);
    });
    connection.once("error", resolve);
  });
  if (probe === undefined) {
    throw new Error(`a broker is already running, it answers on ${file}`);
  }
  if (probe.code !== "ECONNREFUSED" && probe.code !== "ENOENT") throw probe;
  rmSync(file, { force: true });
}
