import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerClient, BrokerNotRunningError, BrokerRequestError } from "./client.js";

let directory: string;
let socketFile: string;
let stub: Server;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "sessionhook-client-"));
  socketFile = join(directory, "stub.sock");
  stub = createServer((request, response) => {
    if (request.url?.startsWith("/events?subscriber=hangs")) return; // never answers
    if (request.url?.startsWith("/events?subscriber=reset")) return void request.socket.destroy();
    const known = request.url?.startsWith("/events?subscriber=known");
    response.writeHead(known ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(known ? { events: [] } : { error: "unknown subscriber" }));
  });
  await new Promise<void>((resolve) => stub.listen(socketFile, resolve));
});

after(() => {
  stub.closeAllConnections();
  stub.close();
  rmSync(directory, { recursive: true, force: true });
});

test("a non-200 reply rejects with the status and the broker's message", async () => {
  await assert.rejects(new BrokerClient(socketFile).events("nobody", 0), (error) => {
    assert.ok(error instanceof BrokerRequestError);
    assert.equal(error.status, 404);
    assert.equal(error.message, "unknown subscriber");
    return true;
  });
});

test("a socket nothing listens on rejects with BrokerNotRunningError", async () => {
  await assert.rejects(new BrokerClient(join(directory, "missing.sock")).status(), BrokerNotRunningError);
});

test("a connection the broker drops mid-request is also BrokerNotRunningError", async () => {
  await assert.rejects(new BrokerClient(socketFile).events("reset", 0), BrokerNotRunningError);
});

test("aborting the signal ends a request the broker has not answered", async () => {
  const controller = new AbortController();
  const pending = new BrokerClient(socketFile).events("hangs", 25, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: "AbortError" });
});

test("a request with a signal that is not aborted still succeeds", async () => {
  const events = await new BrokerClient(socketFile).events("known", 0, new AbortController().signal);
  assert.deepEqual(events, []);
});
