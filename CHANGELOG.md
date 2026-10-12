# Changelog

## 0.1.0

First release. A broker process stores incoming events in a SQLite file and keeps a cursor for each subscriber, so a session that was away catches up on what it missed. A generic webhook source accepts signed requests from any sender and maps fields of the JSON body to an event. A Jira Cloud source turns comments and field changes into events, by polling Jira on a timer, by receiving Jira webhooks, or by both.

Events reach a Claude Code session as a channel, through an MCP server with `subscribe`, `unsubscribe` and `list_subscriptions` tools, or through the `wait` and `tail` commands in a shell. Actor allowlists, ignore lists and an ignore marker decide which events are stored.

`init` writes the config and secrets files and registers the channel server with Claude Code. `doctor` checks the setup, `spawn` starts a tmux session running Claude Code on a ticket, and `service` installs the broker as a login service with systemd on Linux or launchd on macOS. The macOS path has not been run on a Mac.
