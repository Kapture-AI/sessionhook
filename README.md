# sessionhook

sessionhook delivers outside events, such as a comment on a Jira ticket, to running Claude Code sessions. A single broker process stores incoming events in a SQLite file, keeps a cursor for each subscriber, and hands every subscriber the events it has not yet seen, including those that arrived while it was not running.

## Status

The broker, the generic signed webhook source, command line delivery and delivery into a Claude Code session as a channel work. The Jira source, polling, and the `init`, `doctor` and `spawn` commands are not there yet, and those commands print that they are not implemented.

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

The source name (`deploys` above) is the path, so the sender posts to `/hooks/deploys`. It may contain lowercase letters, digits and hyphens. Only the source type `webhook` exists today.

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
