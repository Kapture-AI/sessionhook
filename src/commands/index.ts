import { serve } from "./serve.js";

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
  subscribe: { summary: "Subscribe to a topic" },
  unsubscribe: { summary: "Remove a subscription" },
  status: { summary: "List subscribers, their topics and unread counts" },
  wait: { summary: "Block until there are unread events, print them and exit" },
  tail: { summary: "Stream events as they arrive" },
  replay: { summary: "Send stored events to a subscriber again" },
  spawn: { summary: "Start a tmux session running Claude Code, subscribed to a topic" },
};
