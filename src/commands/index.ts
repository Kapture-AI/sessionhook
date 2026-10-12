import { channel } from "./channel.js";
import { tail, wait } from "./delivery.js";
import { replay } from "./replay.js";
import { serve } from "./serve.js";
import { service } from "./service.js";
import { status } from "./status.js";
import { subscribe, unsubscribe } from "./subscribe.js";

export type Command = {
  summary: string;
  // Absent until the command is implemented.
  run?: (args: string[]) => Promise<void> | void;
};

// A later phase implements a command in its own file and sets `run` here.
export const commands: Record<string, Command> = {
  init: { summary: "Write the config, register the MCP server and print webhook settings" },
  serve: { summary: "Run the broker", run: serve },
  doctor: { summary: "Check the broker, the Jira token and the public webhook URL" },
  subscribe: { summary: "Subscribe to a topic", run: subscribe },
  unsubscribe: { summary: "Remove a subscription", run: unsubscribe },
  status: { summary: "List subscribers, their topics and unread counts", run: status },
  wait: { summary: "Block until there are unread events, print them and exit", run: wait },
  tail: { summary: "Stream events as they arrive", run: tail },
  channel: {
    summary: "Claude Code starts this to deliver events into a session, do not run it by hand",
    run: channel,
  },
  service: { summary: "Install, remove or check the broker as a login service", run: service },
  replay: { summary: "Send stored events to a subscriber again", run: replay },
  spawn: { summary: "Start a tmux session running Claude Code, subscribed to a topic" },
};
