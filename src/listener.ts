import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Broker } from "./broker.js";
import { BadPayloadError, type Source } from "./source.js";

const bodyLimit = 1024 * 1024;
const hookPath = /^\/hooks\/([a-z0-9-]+)$/;

function reply(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

// Resolves to undefined when the body exceeds the limit.
function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"]);
    if (declared > bodyLimit) return resolve(undefined);
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > bodyLimit) {
        request.removeAllListeners("data");
        request.resume();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

// This server never routes to the local API, so a reverse proxy pointed at it
// exposes the hook paths and nothing else.
export function createWebhookServer(
  broker: Broker,
  sources: Record<string, Source>,
  log: (line: string) => void,
): Server {
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const sourceName = request.method === "POST" ? hookPath.exec(request.url ?? "")?.[1] : undefined;
    const source = sourceName === undefined || !Object.hasOwn(sources, sourceName) ? undefined : sources[sourceName];
    if (sourceName === undefined || source === undefined) return reply(response, 404, { error: "not found" });

    const rawBody = await readBody(request);
    if (rawBody === undefined) {
      log(`rejected ${sourceName}: body over ${bodyLimit} bytes`);
      response.setHeader("Connection", "close");
      return reply(response, 413, { error: "body too large" });
    }
    const inbound = { headers: request.headers, rawBody };
    if (!source.authenticate(inbound)) {
      log(`rejected ${sourceName}: signature check failed`);
      return reply(response, 401, { error: "unauthorized" });
    }
    let results: string[];
    try {
      results = broker.intake(sourceName, source.parse(inbound));
    } catch (error) {
      if (error instanceof BadPayloadError) {
        log(`rejected ${sourceName}: ${error.message}`);
        return reply(response, 400, { error: error.message });
      }
      log(`failed ${sourceName}: ${(error as Error).message}`);
      return reply(response, 500, { error: "could not store the event" });
    }
    reply(response, 200, { results });
  }

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      log(`failed handling a request: ${(error as Error).message}`);
      if (!response.headersSent) reply(response, 500, { error: "internal error" });
    });
  });
}
