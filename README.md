# sessionhook

sessionhook delivers outside events, such as a comment on a Jira ticket, to running Claude Code sessions. A single broker process stores incoming events in a SQLite file, keeps a cursor for each subscriber, and hands every subscriber the events it has not yet seen, including those that arrived while it was not running.

## Status

Early development. Nothing here is usable yet. The repository currently holds the project structure, the event types and a command line entry point that prints its version and help.

## Requirements

Node 22.13 or later, on Linux or macOS.

## Build and test

```sh
npm ci
npm test
```

`npm test` compiles the TypeScript to `dist/` and runs the tests with Node's built-in test runner.

## License

MIT
