import type { IncomingHttpHeaders } from "node:http";
import type { NewEvent } from "./event.js";

export type InboundRequest = { headers: IncomingHttpHeaders; rawBody: Buffer };

// Thrown by parse when the request is authentic but its content cannot become an event.
export class BadPayloadError extends Error {}

export interface Source {
  authenticate(request: InboundRequest): boolean;
  parse(request: InboundRequest): NewEvent[];
}
