#!/usr/bin/env node

/**
 * The Goal package's MCP server: the tools the model uses to move a Goal
 * forward.
 *
 * It is the only writer of a run's To-Do list. The flow step reads what this
 * wrote and decides whether to continue, so the completion rule and the state
 * schema are both this package's, not the host's.
 *
 * The server is long-lived and shared across conversations, so it cannot learn
 * which conversation it is serving from its environment. A tool call carries the
 * run token the step handed the model instead, and that token resolves to
 * exactly one run.
 *
 * Nothing but JSON-RPC may reach stdout: stdout is the MCP transport, so every
 * diagnostic goes to stderr.
 */

import { applyGoalUpdate, dataRoot, findRunByToken, runProjection, writeRunFile } from "./lib/goal-state.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "goal";
const SERVER_VERSION = "2.0.0";

const TOOLS = [
  {
    name: "update_goal",
    description:
      "Replace the Goal's To-Do list and record progress. Pass the run token the Goal prompt supplied. " +
      "The Goal completes when the To-Do list is non-empty and every To-Do is completed.",
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string", description: "Run token from the Goal prompt" },
        objective: { type: "string", description: "Restate the objective if it changed" },
        todos: {
          type: "array",
          description: "The complete current To-Do list; it replaces the stored list",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable identifier" },
              task: { type: "string", description: "What must be done" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              result: { type: "string", description: "Outcome once the To-Do is completed" },
            },
            required: ["task"],
          },
        },
        status: {
          type: "string",
          enum: ["running", "failed", "blocked", "cancelled"],
          description:
            "Set failed, blocked, or cancelled for an unrecoverable failure or a need for user input. " +
            "Completion is derived from the To-Do list and cannot be asserted.",
        },
        summary: { type: "string", description: "Short summary of the Goal's outcome" },
      },
      required: ["run"],
    },
  },
  {
    name: "read_goal",
    description: "Read the Goal's current To-Do list, status, and summary.",
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string", description: "Run token from the Goal prompt" },
      },
      required: ["run"],
    },
  },
];

function resolveRun(args) {
  const found = findRunByToken(dataRoot(), args?.run);
  if (found === null) {
    throw new Error(
      "No Goal run matches that token. Pass the exact 'run' value from the Goal prompt for this conversation.",
    );
  }
  return found;
}

function callTool(name, args) {
  if (name === "update_goal") {
    const { run, file } = resolveRun(args);
    applyGoalUpdate(run, args ?? {});
    writeRunFile(file, run);
    return JSON.stringify({ ...runProjection(run), run_id: run.run_id });
  }
  if (name === "read_goal") {
    const { run } = resolveRun(args);
    return JSON.stringify({ ...runProjection(run), run_id: run.run_id });
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case "notifications/initialized":
      return;
    case "ping":
      respond(id, {});
      return;
    case "tools/list":
      respond(id, { tools: TOOLS });
      return;
    case "tools/call": {
      try {
        const text = callTool(params?.name, params?.arguments ?? {});
        respond(id, { content: [{ type: "text", text }], isError: false });
      } catch (error) {
        respond(id, { content: [{ type: "text", text: error.message }], isError: true });
      }
      return;
    }
    default:
      if (id === undefined) return;
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== "") {
      try {
        handle(JSON.parse(line));
      } catch (error) {
        process.stderr.write(`${SERVER_NAME} server: ${error.message}\n`);
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
