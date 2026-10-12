# sessionhook

sessionhook delivers outside events, such as a comment on a Jira ticket, to running Claude Code sessions. A single broker process stores incoming events in a SQLite file, keeps a cursor for each subscriber, and hands every subscriber the events it has not yet seen, including those that arrived while it was not running. Any number of sessions can subscribe to any ticket, and each receives every event.

It is an early release. The commands and the config format can still change between versions.

```
Jira  --poll or webhook-->  broker (events.db)  --channel or wait-->  Claude Code session
```

## Requirements

- Node 22.13 or later, on Linux or macOS.
- A Jira Cloud account and an API token, created at id.atlassian.com under Security, API tokens. The account must be able to see the tickets you subscribe to.
- For delivery into a session as a channel, Claude Code 2.1.80 or later. Without it, `sessionhook wait` delivers the same events and needs nothing from Claude Code.
- For `sessionhook spawn`, tmux 3.2 or later.

## Install

```sh
npm install -g sessionhook
```

Install it globally. `init` writes the absolute path of the installed `cli.js` into Claude Code's settings and into the service, and `npx` unpacks the package into a cache directory that npm may delete later, which would leave both pointing at nothing.

## Quick start

This path needs no domain, no open port and no Jira administrator rights. The broker asks Jira for changes on a timer.

### 1. Run init

```sh
sessionhook init
```

`init` asks for the Jira site address (such as `https://example.atlassian.net`), the mode (press Enter for `poll`), the email of the account that owns the token, and the token, which is not shown as you type. It then asks who may wake a session and for the text that marks your agent's own comments. Both can stay empty, but read [Safety](#safety) before leaving the first one empty.

Before it writes anything, `init` asks Jira who the token belongs to and prints that name, so a wrong token stops here. Then it writes `config.json` and `secrets.json` (mode 600) into `~/.config/sessionhook`, registers the channel server with Claude Code, and offers to install the broker as a service that starts at login. Answer no to the last question if you prefer to run `sessionhook serve` yourself.

Every answer can also be given as an option, so `init` can run unattended.

```sh
sessionhook init --yes --site https://example.atlassian.net --email ada@example.com \
  --mode poll --token-file "${HOME}/jira-token" --allow-actor "Ada Lovelace" \
  --no-register --no-service
```

The token is never accepted as an option, because options show up in `ps` and in shell history. `--yes` accepts the defaults and never asks, and fails with a message when a required answer is missing. Running `init` again shows the existing config, asks before changing it, keeps secrets that are already stored, and keeps other sources and the settings it does not ask about.

### 2. Check the setup

```sh
sessionhook doctor
```

`doctor` prints one line per check and exits non-zero when one fails. If you chose not to install the service, start the broker first with `sessionhook serve` in a terminal of its own. When the channel server is not registered, for example after `init --no-register`, the Claude Code check is reported as `skip` with the registration command, because `sessionhook wait` works without channels.

### 3. Start a session on a ticket

```sh
sessionhook spawn jira:PROJ-123
```

This subscribes a subscriber named `proj-123` to the ticket and starts a detached tmux session named `proj-123` that runs Claude Code with the channel loaded. Claude Code shows a dialog, "WARNING: Loading development channels", at every start. `spawn` watches the tmux pane and presses Enter once when it sees that dialog, because option 1 is preselected. Pass `--no-confirm` to answer it yourself. `tmux attach -t proj-123` shows the session.

Add a comment to PROJ-123. It reaches the session within about 30 seconds in poll mode.

The session is subscribed under the name `proj-123`, so starting `spawn` again with the same name, after killing the session or rebooting, continues from where that subscriber stopped and delivers what it missed. The options are `--cwd <dir>` for the directory the session starts in, `--name <name>` for a different session and subscriber name, and `--prompt <text>` for the first prompt.

### Without spawn

A session that is already running, or one that cannot carry the channel flag, can subscribe from a shell and wait for events.

```sh
sessionhook subscribe jira:PROJ-123 --name my-session
sessionhook wait --name my-session
```

`wait` blocks until there is an unread event, prints it and exits. A Claude Code session can run it as a background task and is woken when it exits. The [CLI delivery](#cli-delivery) section has the details.

## What a session sees

With the channel, each event arrives in the session as a message.

```
<channel source="sessionhook" topic="jira:PROJ-123" event_type="comment_created" seq="12" actor="Ada Lovelace" at="2026-10-12T10:00:00.000Z" url="https://example.atlassian.net/browse/PROJ-123?focusedCommentId=20001">
#12 jira:PROJ-123 comment_created
by Ada Lovelace at 2026-10-12T10:00:00.000Z
https://example.atlassian.net/browse/PROJ-123?focusedCommentId=20001
Deploy check passed, safe to ignore.
</channel>
```

The session also has three tools, `subscribe`, `unsubscribe` and `list_subscriptions`, so it can add a ticket at runtime. With `wait`, the session reads the same block from the command's output.

## Commands

| Command | What it does |
|---|---|
| `sessionhook init` | Sets up the Jira source, the secrets file, the Claude Code registration and the service. |
| `sessionhook serve` | Runs the broker in the foreground. |
| `sessionhook doctor` | Checks the config, the broker, the Jira token, the public webhook URL and Claude Code. |
| `sessionhook spawn <topic>` | Starts a tmux session running Claude Code, subscribed to the topic. |
| `sessionhook subscribe <topic>`, `unsubscribe <topic>`, `status` | Manage subscriptions from a shell. |
| `sessionhook wait`, `tail`, `replay` | Read events from a shell. |
| `sessionhook service install`, `uninstall`, `status` | Manage the broker as a login service. |
| `sessionhook channel` | The MCP server Claude Code starts. Do not run it by hand. |

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

`config.json` has four top-level keys, all optional.

```json
{
  "listen": { "host": "127.0.0.1", "port": 8377 },
  "publicUrl": "https://hooks.example.com",
  "spawn": { "claudeFlags": ["--model", "some-model"], "prompt": "Wait for events and handle each one." },
  "sources": {}
}
```

`listen` defaults to `127.0.0.1:8377`. Keep the host on a loopback address and put a reverse proxy or tunnel in front of it when a sender outside the machine has to reach it. The broker does not stop you from binding another address.

`publicUrl` is the origin that reaches the webhook listener from outside, an `https://` address with no path. `init` uses it to print the webhook URL, and `doctor` uses it to test that the address reaches this broker.

`spawn.claudeFlags` is a list of extra options that `spawn` passes to `claude` as they are, and `spawn.prompt` is the first prompt for spawned sessions when `--prompt` is not given. `spawn` adds no permission option of its own. It never passes `--dangerously-skip-permissions` unless you put it in `claudeFlags`.

`init` sets up the Jira source. The generic webhook source below is set up by editing `config.json`.

### Secrets

Settings that need a secret hold its name, never the value. The broker looks the name up in `secrets.json`, then in the environment variable of the same name, then in the file named by the variable `<NAME>_FILE` (the Docker convention, the file's content is the secret). `secrets.json` is a flat object of names to values and must have mode 600, and so must a `<NAME>_FILE` file, or the broker refuses to read it. `init` creates `secrets.json` with that mode.

```json
{ "DEPLOYS_WEBHOOK_SECRET": "a long random string" }
```

```sh
chmod 600 "${HOME}/.config/sessionhook/secrets.json"
```

A machine that already keeps its Jira token in a file can skip the copy by exporting `JIRA_API_TOKEN_FILE` with that file's path in the environment of the broker.

### Actor filters

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
      "ignoreFields": [],
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
| `ignoreFields` | Names of changed fields, exactly as Jira sends them, such as `Attachment` or `Rank`. Changes to these fields are left out of `issue_updated` events. Default is an empty list. |
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

Webhook mode is instant and needs Jira to reach the broker, so the listener needs a public address (see below). Jira posts to `https://<your host>/hooks/jira`, where `jira` is the source name. Jira appends its own query parameters to the URL, and the listener ignores them.

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

`ignoreFields` is a filter for `issue_updated` events only, and it applies in both modes. A listed field is left out of the summary, and an update whose changed fields are all listed produces no event, though the webhook is still answered 200. An agent that uploads files to a ticket under a human's account makes updates that contain only `Attachment`, which would wake the session that made them. Moving cards on a board makes `Rank` updates that nobody needs to read. Listing these two fields silences both.

### Getting a public address for webhook mode

The listener binds to `127.0.0.1:8377` and serves only `/hooks/*`, so a proxy pointed at it never exposes subscriptions or events. Setting up the address is up to you, and these are three ways.

- A reverse proxy on a server with a domain, such as Caddy or nginx, that forwards `/hooks/` to `127.0.0.1:8377`.
- Tailscale Funnel or an ngrok static address, for a machine without a domain. `tailscale funnel 8377` publishes the port on a `ts.net` address, and ngrok can forward a reserved domain to the port.
- A relay such as smee.io or Hookdeck, which receives the webhook on a public address and forwards it to a client on your machine. The signature covers the exact bytes of the body, so check that the relay forwards the body and the `X-Hub-Signature` header unchanged.

## Generic webhook source

The source type `webhook` accepts signed requests from any sender and maps fields of the JSON body to an event, with no code. It is configured by editing `config.json`, `init` does not set it up. This is an example source named `deploys`.

```json
{
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

The source name (`deploys` above) is the path, so the sender posts to `/hooks/deploys`. It may contain lowercase letters, digits and hyphens. The source type is `webhook` or `jira`, and the Jira source has its own section above.

`signature.secret` is the name of a secret, see [Secrets](#secrets).

The signature is the HMAC-SHA256 of the raw request body as hex, compared against the configured header after the configured prefix is removed.

The `map` entries are dotted paths into the JSON body. Only `key` is required. The event topic is `<source name>:<value at key>`, and the event id is `<source name>:<value at id>`, or the source name and the SHA-256 of the raw body when `id` is not mapped or missing. The same request sent twice is therefore stored once. When a mapping is absent or its path is missing, `type` is `event`, the actor is empty, `at` is the time the request arrived, and `url` and `summary` are empty. A summary is cut to 2,000 characters. A body that is not JSON, or has no value at `key`, is answered with 400.

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

## Channel delivery

A channel pushes events into a running Claude Code session as messages, with no watcher process to arm. Claude Code starts `sessionhook channel` as an MCP server for the session, the server follows the broker for the session's subscriber name, and each event becomes one channel message.

Channels need Claude Code 2.1.80 or later. They are a research preview, so a server that is not on Anthropic's allowlist loads only through the development flag described below. Organisations on Claude Team or Enterprise have channels off until an owner enables them. If that is you, use `sessionhook wait` instead, which needs nothing from Claude Code.

`sessionhook init` registers the server with Claude Code at user scope, using the absolute paths of `node` and of the installed `cli.js` so that the entry works whatever PATH a session starts with. To do it by hand, run the following with the real paths.

```sh
claude mcp add --scope user sessionhook -- /usr/local/bin/node /usr/local/lib/node_modules/sessionhook/dist/cli.js channel
```

Register at user scope. A server that is declared in a project's `.mcp.json` adds a consent prompt whose default declines it.

`sessionhook spawn` starts a session with the flag for you. To start one by hand, put the prompt before the development flag, because the flag takes a list.

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

The safety section below explains who can drive a subscribed session.

## CLI delivery

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

## Service

`sessionhook service install` runs the broker at login and restarts it when it stops. `uninstall` stops and removes it, and `status` shows whether it is installed and running. Each asks before replacing or removing an existing service unless you pass `--yes`.

On Linux it writes `~/.config/systemd/user/sessionhook.service`, runs `systemctl --user daemon-reload` and `systemctl --user enable --now sessionhook.service`. The unit restarts the broker two seconds after it exits. If `SESSIONHOOK_CONFIG_DIR` or `SESSIONHOOK_STATE_DIR` is set when you run the command, the unit carries the same values. A user service stops when you log out unless lingering is on, and the command prints the `loginctl enable-linger` line to run when it is off.

On macOS it writes `~/Library/LaunchAgents/com.sessionhook.broker.plist` with `RunAtLoad` and `KeepAlive`, and loads it with `launchctl bootstrap gui/<uid>`. Its output goes to `~/Library/Logs/sessionhook.log`. The macOS path has not been run on a Mac. The generated plist is covered by unit tests and written from Apple's documented format, so treat it as untested, and report what you find.

## Delivery guarantee

Delivery is at-least-once. The broker keeps one cursor per subscriber, the commands print events and only then acknowledge them, and a crash in between delivers the same events again on the next run. Two subscribers on one topic each receive every event. A subscription only sees events that arrive after it was made, and a subscriber that was away catches up from its cursor. If the broker is not running, the commands fail and say to start it with `sessionhook serve`.

## Safety

A subscribed session acts on text written by other people. A comment on a ticket can ask the model to do things, and the model may do them. The control is the actor allowlist, `allowActors` on each source, which decides whose events reach any session. With the list empty, anyone who can comment on a ticket you subscribe to can wake a session and give it instructions.

Combined with `--dangerously-skip-permissions`, anyone on the allowlist can drive the session, so keep the list to people you would give a shell. `spawn` never adds that option. It is passed only when you put it in `spawn.claudeFlags`.

An agent that posts comments under a human's account should end each comment with a fixed text and set `ignoreMarker` to it, so its own comments wake nothing.

## Troubleshooting

Run `sessionhook doctor` first. It names the check that failed and says what to do.

The broker is not running. Every command except `serve`, `init` and `doctor` fails with "the broker is not running". Start it with `sessionhook serve`, or with `sessionhook service install` to have it start at login. A broker that was started with other `SESSIONHOOK_CONFIG_DIR` or `SESSIONHOOK_STATE_DIR` values than your shell has is a different broker, so set the same values for both.

Channels are off for Team and Enterprise organisations. Claude Code ignores channels there until an owner enables them. `doctor` cannot see that setting. Use `sessionhook wait` as a background task in the session, which works without channels.

The development channels dialog. Claude Code asks "WARNING: Loading development channels" at every start, including `--resume`, and no setting removes it. `spawn` presses Enter when the dialog appears. If it never appeared within 30 seconds, the session may be waiting on another prompt, such as a question whether to trust the folder. Attach with `tmux attach -t <name>` and answer it. The flag is ignored by `claude -p`, so a channel needs an interactive session.

A Jira token that stops working. `doctor` reports a 401 or 403 as a wrong email or token. Create a new token, run `init` again with `--token-file`, and confirm replacing the stored one.

Nothing arrives in poll mode. The poll runs every 30 seconds by default, and the topic must match the ticket key exactly, as in `jira:PROJ-123`. The broker logs poll failures once when they start and once when they end, so look at its log (`journalctl --user -u sessionhook` for the Linux service).

The webhook URL does not reach the listener. `doctor` tells apart a wrong webhook secret (401), an address that leads to something else, and no connection. See the section on getting a public address under the Jira source.

## Build and test

```sh
npm ci
npm test
```

`npm test` compiles the TypeScript to `dist/` and runs the tests with Node's built-in test runner. The tests use loopback and unix sockets only, and never touch your real config, Claude Code settings, systemd or tmux.

## Releasing

For maintainers. Set the new version in `package.json` (`npm version <version> --no-git-tag-version`), commit it through a pull request, and wait for the tests to pass on `main`. Tag the merge commit `vX.Y.Z`, push the tag, and run the publish workflow on it.

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
gh workflow run publish.yml --ref vX.Y.Z
```

The workflow fails unless the ref is the tag `v<version>` that matches `package.json`. It publishes with npm trusted publishing, so no npm token is stored anywhere. The trusted publisher entry on npmjs.com must name this repository and the workflow file `publish.yml`.

## License

MIT, see [LICENSE](LICENSE).
