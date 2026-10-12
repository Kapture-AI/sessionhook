# sessionhook

sessionhook delivers outside events, such as a comment on a Jira ticket, to running Claude Code sessions. A single broker process stores incoming events in a SQLite file, keeps a cursor for each subscriber, and hands every subscriber the events it has not yet seen, including those that arrived while it was not running.

## Status

The broker, the generic signed webhook source, the Jira source (webhook and poll modes), command line delivery and delivery into a Claude Code session as a channel work. The `init`, `doctor` and `spawn` commands are not there yet, and those commands print that they are not implemented.

## Requirements

Node 22.13 or later, on Linux or macOS.

## How it works

`sessionhook serve` runs the broker in the foreground. It listens for signed webhook requests on a local HTTP port and keeps every accepted event in a SQLite file. Each subscriber has a name, a set of topics and a cursor. Other commands talk to the broker over a unix socket, so the webhook port never exposes subscriptions or events.

A topic is `<source>:<key>`, for example `deploys:acme/web`. Topics match by exact string, there are no wildcards.

## Configuration

Both directories can be moved with an environment variable.

| What | Default | Override |
|---|---|---|
| Config directory, holding `config.json` and `secrets.json` | `~/.config/sessionhook` | `SESSIONHOOK_CONFIG_DIR` |
| State directory, holding `events.db` and `broker.sock` | `~/.local/state/sessionhook` | `SESSIONHOOK_STATE_DIR` |

The broker creates the state directory with mode 700 when it does not exist. A missing `config.json` means the defaults, which is a broker with no sources.

```json
{
  "listen": { "host": "127.0.0.1", "port": 8377 },
  "sources": {
    "deploys": {
      "type": "webhook",
      "signature": { "header": "X-Hub-Signature-256", "prefix": "sha256=", "secret": "DEPLOYS_WEBHOOK_SECRET" },
      "map": {
        "key": "repository.full_name",
        "id": "delivery.id",
        "type": "action",
        "actorId": "sender.id",
        "actorName": "sender.login",
        "at": "created_at",
        "url": "html_url",
        "summary": "message"
      },
      "allowActors": [],
      "ignoreActors": [],
      "ignoreMarker": ""
    }
  }
}
```

`listen` defaults to `127.0.0.1:8377`. Keep the host on a loopback address and put a reverse proxy or tunnel in front of it when a sender outside the machine has to reach it. The broker does not stop you from binding another address.

The source name (`deploys` above) is the path, so the sender posts to `/hooks/deploys`. It may contain lowercase letters, digits and hyphens. The source type is `webhook` or `jira`, and the Jira source has its own section below.

`signature.secret` is the name of a secret, never the value. The broker looks the name up in `secrets.json` and then in the environment variable of the same name. `secrets.json` is a flat object of names to values and must have mode 600, or the broker refuses to read it.

```json
{ "DEPLOYS_WEBHOOK_SECRET": "a long random string" }
```

```sh
chmod 600 "${HOME}/.config/sessionhook/secrets.json"
```

The signature is the HMAC-SHA256 of the raw request body as hex, compared against the configured header after the configured prefix is removed.

The `map` entries are dotted paths into the JSON body. Only `key` is required. The event topic is `<source name>:<value at key>`, and the event id is `<source name>:<value at id>`, or the source name and the SHA-256 of the raw body when `id` is not mapped or missing. The same request sent twice is therefore stored once. When a mapping is absent or its path is missing, `type` is `event`, the actor is empty, `at` is the time the request arrived, and `url` and `summary` are empty. A summary is cut to 2,000 characters. A body that is not JSON, or has no value at `key`, is answered with 400.

The three filter settings apply to every event before it is stored.

- `allowActors`, when not empty, lets through only events whose actor id or actor name is listed.
- `ignoreActors` drops events whose actor id or name is listed.
- `ignoreMarker`, when not empty, drops events whose summary contains it.

A dropped event is not stored, the sender still gets a 200, and `serve` logs which rule dropped it.

## Jira source

The `jira` source type turns comments and field changes on Jira Cloud tickets into events. It can ask Jira for changes on a timer (poll mode), receive webhooks from Jira (webhook mode), or do both.

```json
{
  "sources": {
    "jira": {
      "type": "jira",
      "site": "https://example.atlassian.net",
      "email": "ada@example.com",
      "token": "JIRA_API_TOKEN",
      "poll": { "intervalSeconds": 30 },
      "webhookSecret": "JIRA_WEBHOOK_SECRET",
      "allowActors": [],
      "ignoreActors": [],
      "ignoreMarker": ""
    }
  }
}
```

| Key | Meaning |
|---|---|
| `site` | The address of your Jira Cloud site. It must start with `https://` and have no path. Links in events are built from it. |
| `email` | The email address of the Atlassian account that owns the API token. Needed when `poll` is set. |
| `token` | The name of a secret that holds the API token, never the token itself. Needed when `poll` is set. |
| `poll` | Turns on poll mode. `intervalSeconds` defaults to 30 and cannot be below 5. Write `"poll": {}` for the defaults. |
| `webhookSecret` | The name of a secret that holds the webhook secret, never the secret itself. Setting it turns on webhook mode. Without it the source answers every request to its webhook path with 401. |
| `allowActors`, `ignoreActors`, `ignoreMarker` | The filters described under Configuration. Actors are matched by Atlassian account id or display name. |

At least one of `poll` and `webhookSecret` is required. The topic of an event is the source name, a colon and the ticket key, so with the source named `jira` a ticket is `jira:PROJ-123`. A subscription to anything else under the `jira` source, such as `jira:proj-123`, never matches, and in poll mode the broker logs that once.

### Poll mode

Poll mode needs no URL, domain, open port or Jira administrator rights. The broker asks Jira for the subscribed tickets that changed recently, using the API token of one Atlassian account. That account must be able to see the tickets.

Create the token at id.atlassian.com under Security, API tokens, and put it where the broker finds secrets, in `secrets.json` or in the environment (see Configuration).

```json
{ "JIRA_API_TOKEN": "the token from id.atlassian.com" }
```

Every `intervalSeconds` the broker sends one search request, `POST /rest/api/3/search/jql`, listing all subscribed tickets with `updated >= <epoch milliseconds>`, and asks for each ticket's comments and change history in the same response. That is one request per interval however many tickets are subscribed. A ticket that changed in the last minute and has more than 20 comments, or a long enough history, costs one more request for the part the search cut off. When no ticket is subscribed the broker makes no request at all.

Each search starts 60 seconds before the last successful one, because Jira's search index shows a new comment a couple of seconds late. The repeats are dropped by event id, so a comment is stored once. The first poll ever starts at the time the broker started (less the overlap), so older tickets are not replayed. The position is kept in the event database, so a broker that was stopped catches up from it when it starts again, up to the newest 100 comments and 100 history entries per ticket.

If Jira cannot be reached or refuses the token, the broker keeps running and retries on the next interval. It logs one line when polling starts failing, with the HTTP status (and a hint when the email or token is wrong), and one line when it recovers. After a 429 it waits for the time Jira asks for. The token and the Authorization header are never logged.

### Webhook mode

Webhook mode is instant and needs Jira to reach the broker, so the listener needs a public address (see below). Jira posts to `https://<your host>/hooks/jira`, where `jira` is the source name.

In Jira, open Settings, System, WebHooks and create a webhook. Set the URL, put the same string as the secret that `webhookSecret` names, and tick these events.

- Issue: updated
- Comment: created
- Comment: updated

Jira signs each request with `X-Hub-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body, and the broker rejects a request with a wrong or missing signature with 401. Any other kind of event, such as an issue being created, is answered with 200 and stores nothing.

When the event cannot be stored the listener answers 500. Jira retries after a 408, 409, 425, 429 or 5xx answer, the first retry about six minutes later with the identical body, and the retry is stored once because it produces the same event id.

### Poll and webhook together

Set both `poll` and `webhookSecret` to get webhooks as the fast path and the poll as the safety net for webhooks that never arrive. Both modes produce the same event id for the same comment or change, so an event that arrives twice is stored once.

### Events

| Type | Id | When |
|---|---|---|
| `comment_created` | `<source>:comment:<comment id>` | Someone adds a comment. |
| `comment_updated` | `<source>:comment:<comment id>:updated:<update time in epoch ms>` | Someone edits a comment. Each edit is its own event. |
| `issue_updated` | `<source>:changelog:<change history id>` | A field changes. The summary has one line per changed field. |

Comment text is converted to plain text and cut to 2,000 characters. As `wait` prints them:

```
#12 jira:PROJ-123 comment_created
by Ada Lovelace at 2026-10-12T09:56:41.681Z
https://example.atlassian.net/browse/PROJ-123?focusedCommentId=20001
Deploy check passed, safe to ignore.
```

```
#13 jira:PROJ-123 comment_updated
by Grace Hopper at 2026-10-12T10:05:00.000Z
https://example.atlassian.net/browse/PROJ-123?focusedCommentId=20001
Deploy check passed after a rerun.
```

```
#14 jira:PROJ-123 issue_updated
by Ada Lovelace at 2026-10-12T09:36:10.213Z
https://example.atlassian.net/browse/PROJ-123
status: To Do -> In Progress
resolution: none -> Done
```

### Filters

The filters from Configuration apply to Jira events in both modes. `allowActors` limits who can wake a session, `ignoreActors` silences accounts such as bots, and `ignoreMarker` exists for agents that post comments under a human's account. Have the agent end each comment with a fixed text such as `[agent]` and set `ignoreMarker` to that text, so the agent's own comments do not wake the sessions subscribed to the ticket.

### Getting a public address for webhook mode

The listener binds to `127.0.0.1:8377` and serves only `/hooks/*`, so a proxy pointed at it never exposes subscriptions or events. Setting up the address is up to you, and these are three ways.

- A reverse proxy on a server with a domain, such as Caddy or nginx, that forwards `/hooks/` to `127.0.0.1:8377`.
- Tailscale Funnel or an ngrok static address, for a machine without a domain. `tailscale funnel 8377` publishes the port on a `ts.net` address, and ngrok can forward a reserved domain to the port.
- A relay such as smee.io or Hookdeck, which receives the webhook on a public address and forwards it to a client on your machine. The signature covers the exact bytes of the body, so check that the relay forwards the body and the `X-Hub-Signature` header unchanged.

## Running the broker

```sh
export DEPLOYS_WEBHOOK_SECRET="a long random string"
sessionhook serve
```

`serve` runs in the foreground and writes one line to stderr at startup and for each stored, duplicate, filtered or rejected event. It never logs a secret or a request body. It stops on SIGINT and SIGTERM. Node prints an experimental warning for its built-in SQLite module when `serve` starts, and no other command loads that module. If a broker already answers on the socket, a second `serve` refuses to start, and a socket file that nothing answers on is removed.

The listener answers `POST /hooks/<source>` and nothing else. The status codes are 200 for a stored, duplicate or filtered event, 400 for a bad payload, 401 for a failed signature check, 404 for an unknown source or path, 413 for a body over 1 MB and 500 when the event cannot be stored, so a sender that retries will retry.

Send a signed request with curl.

```sh
body='{"repository":{"full_name":"acme/web"},"delivery":{"id":"d-1"},"action":"deployed","sender":{"login":"Ada Lovelace"},"message":"Release 1.2 is live"}'
signature="$(printf '%s' "${body}" | openssl dgst -sha256 -hmac "${DEPLOYS_WEBHOOK_SECRET}" | sed 's/^.* //')"
curl -sS -X POST "http://127.0.0.1:8377/hooks/deploys" \
  -H "X-Hub-Signature-256: sha256=${signature}" \
  --data-binary "${body}"
```

## Subscribing and reading events

```sh
sessionhook subscribe deploys:acme/web --name my-session
sessionhook unsubscribe deploys:acme/web --name my-session
sessionhook status
sessionhook wait --name my-session
sessionhook tail --name my-session
sessionhook replay --from 12 --name my-session
```

The subscriber name is taken from `--name`, then the environment variable `SESSIONHOOK_SUBSCRIBER`, then `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for the shells it starts. Without any of them the command fails and says how to pass one.

`subscribe` and `unsubscribe` take one topic. `status` prints a table of subscribers with their topics, unread count and last seen time, or `status --json` for scripts.

`wait` blocks without output until the subscriber has unread events, prints them all, acknowledges them and exits with status 0. A Claude Code session can run it as a background task and is woken when it exits. Each event prints as a short block.

```
#12 deploys:acme/web deployed
by Ada Lovelace at 2026-10-12T10:00:00.000Z
https://example.com/deploys/1
Release 1.2 is live
```

`tail` does the same without exiting. `wait --json` and `tail --json` print one JSON object per line instead.

`replay --from <seq>` moves the subscriber's cursor back so that events from that sequence number are delivered again by `wait` or `tail`, and prints how many are now unread. It does not reach back before the subscription was made.

## Channel delivery

A channel pushes events into a running Claude Code session as messages, with no watcher process to arm. Claude Code starts `sessionhook channel` as an MCP server for the session, the server follows the broker for the session's subscriber name, and each event becomes one channel message.

Channels need Claude Code 2.1.80 or later. They are a research preview, so a server that is not on Anthropic's allowlist loads only through the development flag described below. Organisations on Claude Team or Enterprise have channels off until an owner enables them. If that is you, use `sessionhook wait` instead, which needs nothing from Claude Code.

Register the server once. This is a manual step until `init` exists.

```sh
claude mcp add --scope user sessionhook -- sessionhook channel
```

Start the session with the development flag. The flag takes a list, so the prompt must come before it.

```sh
claude "Wait for channel messages." --dangerously-load-development-channels server:sessionhook
```

Claude Code shows a full-screen dialog, "WARNING: Loading development channels", on every start, including `--resume`. Option 1 is preselected, so Enter accepts it. A project that registers the server in its own `.mcp.json` also asks once whether to use that server, and that prompt defaults to not using it. The flag is ignored in non-interactive mode (`-p`), so a channel needs an interactive session.

The subscriber name is `SESSIONHOOK_SUBSCRIBER` if set, otherwise the session id that Claude Code passes to the server as `CLAUDE_CODE_SESSION_ID`. The id stays the same across `--resume`, so a resumed session keeps its subscriptions and catches up on what it missed. With neither variable set the server still starts, writes the reason to stderr, and every tool call returns an error that says so.

The session gets three tools.

| Tool | What it does |
|---|---|
| `subscribe` | Takes a `topic` such as `deploys:acme/web`. Events that arrive after the call are delivered. |
| `unsubscribe` | Takes a `topic` and stops delivery for it. |
| `list_subscriptions` | Takes no arguments. Returns this session's topics and its unread count, never another session's. |

A tool call that fails, for an invalid topic or a stopped broker, comes back as an error result with a message that says what to do, and the server keeps running. A session that has not subscribed to anything yet is idle, and the server checks again every 5 seconds or at once when `subscribe` succeeds.

The session sees each event as a `<channel source="sessionhook" ...>` message. The body is the same block that `wait` prints, and the tag carries the attributes `topic`, `event_type`, `seq`, `actor`, `at` and `url`, left out when empty.

```
<channel source="sessionhook" topic="deploys:acme/web" event_type="deployed" seq="12" actor="Ada Lovelace" at="2026-10-12T10:00:00.000Z" url="https://example.com/deploys/1">
#12 deploys:acme/web deployed
by Ada Lovelace at 2026-10-12T10:00:00.000Z
https://example.com/deploys/1
Release 1.2 is live
</channel>
```

Delivery into Claude Code is at-least-once. The server acknowledges an event only after its notification is written, so a crash in between sends it again. Claude Code does not confirm that the model processed a message, so a message can still be lost to the session in a crash at that moment. The event stays stored and `sessionhook replay --from <seq>` sends it again. Events that arrive while Claude is busy are queued and delivered on its next turn.

If the broker is not running, the server logs one line to stderr, retries with a delay that grows from 1 second to 15 seconds, logs one line when the broker is back and carries on. The cursor lives in the broker, so nothing is lost in between, and `sessionhook status` shows the session's last seen time moving while its channel is alive.

A subscribed session acts on text written by other people. A comment on a ticket can ask the model to do things, and the model may do them. The control is the actor allowlist on each source, which decides whose events reach any session. Combined with `--dangerously-skip-permissions`, anyone on the allowlist can drive the session, so keep the list to people you would give a shell.

## Delivery guarantee

Delivery is at-least-once. The broker keeps one cursor per subscriber, the commands print events and only then acknowledge them, and a crash in between delivers the same events again on the next run. Two subscribers on one topic each receive every event. A subscription only sees events that arrive after it was made, and a subscriber that was away catches up from its cursor. If the broker is not running, the commands fail and say to start it with `sessionhook serve`.

## Build and test

```sh
npm ci
npm test
```

`npm test` compiles the TypeScript to `dist/` and runs the tests with Node's built-in test runner.

## License

MIT
