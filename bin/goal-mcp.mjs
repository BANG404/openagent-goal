#!/usr/bin/env node

/**
 * Goal's complete domain implementation.
 *
 * OpenAgent supplies only the generic MCP transport and host bridge. This
 * process owns the Goal state, completion rule, progress projection, and the
 * decision to wake the next agent turn. A Runtime restart is recovered from
 * PLUGIN_DATA rather than from an in-process flow loop.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { context, createHostClient, requireConversationContext } from "./lib/openagent-host.mjs";
import {
  applyGoalUpdate,
  dataRoot,
  findRunByToken,
  isTerminal,
  readRun,
  runProjection,
  writeRunFile,
} from "./lib/goal-state.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "goal";
const SERVER_VERSION = "3.0.0";
const root = dataRoot();
const host = createHostClient();
const pendingWakes = new Map();

export function wakeScopeKey(conversationId, branchId) {
  return `${String(conversationId)}\u0000${branchId ?? ""}`;
}

const TOOLS = [
  {
    name: "update_goal",
    description:
      "Replace the Goal's complete To-Do list and record progress. Pass the run token from the Goal prompt. The package wakes the next turn when the Goal remains active.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
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
          description: "Use failed, blocked, or cancelled only when the package cannot continue.",
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
      additionalProperties: false,
      properties: { run: { type: "string", description: "Run token from the Goal prompt" } },
      required: ["run"],
    },
  },
];

function conversationContext(args) {
  const value = requireConversationContext(args);
  if (!value.conversationId) throw new Error("OpenAgent did not provide a conversation context");
  return value;
}

function resolveRun(args) {
  const { conversationId, branchId } = conversationContext(args);
  const token = String(args?.run ?? "").trim();
  const found = findRunByToken(root, token);
  if (
    found &&
    found.run.conversation_id === conversationId &&
    (found.run.branch_id ?? null) === (branchId ?? null)
  ) {
    return { ...found, conversationId, branchId };
  }
  throw new Error("No Goal run matches this conversation, branch, and run token");
}

function projectionPayload(run) {
  return {
    plugin_id: "goal",
    conv_id: run.conversation_id,
    flow_id: "plugin:goal:goal",
    status: run.status,
    flow: {
      kind: "plugin",
      state: {
        plugin_id: "goal",
        flow_id: "plugin:goal:goal",
        ...runProjection(run),
      },
    },
    branch_id: run.branch_id,
  };
}

async function emitProjection(run) {
  const payload = projectionPayload(run);
  if (run.branch_id) {
    await host.conversation
      .setFlow(run.conversation_id, run.branch_id, payload.flow)
      .catch(() => {});
  }
  await host.event.emit("plugin-flow-updated", payload).catch(() => {});
}

function continuationPrompt(run, previousOutput = "") {
  const instruction = isTerminal(run)
    ? `The Goal is finished with status "${run.status}". Start no new work; state the final outcome.`
    : run.todos.length === 0
      ? "The Goal still has no To-Dos. Call update_goal now to create a concrete, stable list before continuing."
      : "Continue the pending or in-progress To-Dos and call update_goal whenever their state changes.";
  const output = String(previousOutput ?? "").trim();
  return [
    "This is a private control continuation from the OpenAgent Goal plugin.",
    "",
    `Record progress by calling update_goal with run=\"${run.run_id}\".`,
    "",
    `Current Goal state:\n${JSON.stringify(runProjection(run), null, 2)}`,
    ...(output ? ["", `Previous execution output:\n${output}`] : []),
    "",
    instruction,
    "The Goal completes only after the To-Do list is non-empty and every item is completed.",
  ].join("\n");
}

function scheduleWake(run, branchId) {
  if (isTerminal(run)) return;
  const scheduledBranchId = run.branch_id ?? branchId ?? null;
  const key = wakeScopeKey(run.conversation_id, scheduledBranchId);
  if (pendingWakes.get(key) === run.run_id) return;
  pendingWakes.set(key, run.run_id);
  run.wake_pending = true;
  const found = findRunByToken(root, run.run_id);
  if (found && found.run.conversation_id === run.conversation_id && found.run.branch_id === scheduledBranchId) {
    writeRunFile(found.file, run);
  }
  let attempt = 0;
  const tick = async () => {
    attempt += 1;
    const current = readRun(root, run.conversation_id, scheduledBranchId);
    if (!current || current.run_id !== run.run_id) {
      if (pendingWakes.get(key) === run.run_id) pendingWakes.delete(key);
      return;
    }
    if (isTerminal(current)) {
      current.wake_pending = false;
      const terminalFile = findRunByToken(root, current.run_id);
      if (terminalFile) writeRunFile(terminalFile.file, current);
      if (pendingWakes.get(key) === run.run_id) pendingWakes.delete(key);
      return;
    }
    try {
      const detail = await host.conversation.state(run.conversation_id, scheduledBranchId);
      // The state lookup can yield while another command replaces this branch's
      // package run. Re-read the package source of truth before submitting so an
      // old continuation cannot wake the new run.
      const latest = readRun(root, run.conversation_id, scheduledBranchId);
      if (!latest || latest.run_id !== run.run_id || isTerminal(latest)) {
        if (pendingWakes.get(key) === run.run_id) pendingWakes.delete(key);
        return;
      }
      const selectedBranch = scheduledBranchId || latest.branch_id || detail.branch_id || null;
      await host.agent.wake(
        {
          conv_id: latest.conversation_id,
          branch_id: selectedBranch,
          // The generic bridge resolves a branch's current head immediately
          // before submission, after any active turn retry has drained.
          parent_checkpoint_id: null,
          text: continuationPrompt(latest),
          attachments: [],
          contexts: [],
          model_binding: null,
          user_message_id: null,
          assistant_message_id: null,
          hidden: true,
          flow: {
            kind: "plugin",
            state: {
              plugin_id: "goal",
              flow_id: "plugin:goal:goal",
              title: latest.objective,
              status: latest.status,
              items: runProjection(latest).items,
              summary: latest.summary,
            },
          },
        },
        { wait: false },
      );
      const accepted = readRun(root, run.conversation_id, scheduledBranchId);
      if (accepted?.run_id === run.run_id) {
        accepted.wake_pending = false;
        const currentFile = findRunByToken(root, accepted.run_id);
        if (currentFile) writeRunFile(currentFile.file, accepted);
      }
      if (pendingWakes.get(key) === run.run_id) pendingWakes.delete(key);
    } catch (error) {
      const latest = readRun(root, run.conversation_id, scheduledBranchId);
      if (!latest || latest.run_id !== run.run_id) {
        if (pendingWakes.get(key) === run.run_id) pendingWakes.delete(key);
        return;
      }
      if (attempt >= 80) {
        if (pendingWakes.get(key) === run.run_id) pendingWakes.delete(key);
        process.stderr.write(`goal wake failed for ${run.conversation_id}: ${error.message}\n`);
        return;
      }
      setTimeout(() => void tick(), Math.min(1500, 100 + attempt * 100));
    }
  };
  setTimeout(() => void tick(), 100);
}

async function recoverRunningRuns() {
  const directory = path.join(root, "runs");
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(directory, entry), "utf8"));
      if (parsed?.status !== "running" || !parsed?.conversation_id) continue;
      const stored = readRun(root, parsed.conversation_id, parsed.branch_id ?? null);
      if (!stored || stored.run_id !== parsed.run_id) continue;
      if (!parsed.wake_pending) {
        try {
          const detail = await host.conversation.state(
            stored.conversation_id,
            stored.branch_id ?? undefined,
          );
          // A before-completion checkpoint means the Agent is still in the
          // turn that owns this run. Let it finish before recovering; a final
          // checkpoint with a running Goal means the process stopped after the
          // turn and needs another package-owned continuation.
          if (detail?.phase === "before_completion") continue;
        } catch {
          // If the conversation cannot be inspected yet, keep the durable
          // package state recoverable and retry through the normal wake path.
        }
      }
      scheduleWake(stored, stored.branch_id || null);
    } catch {
      // A malformed package state file is ignored; the next command can repair it.
    }
  }
}

async function callTool(name, args) {
  if (name === "update_goal") {
    const found = resolveRun(args);
    applyGoalUpdate(found.run, args ?? {});
    found.run.iteration += 1;
    writeRunFile(found.file, found.run);
    await emitProjection(found.run);
    if (!isTerminal(found.run)) scheduleWake(found.run, conversationContext(args).branchId);
    return JSON.stringify({ ...runProjection(found.run), run_id: found.run.run_id });
  }
  if (name === "read_goal") {
    const found = resolveRun(args);
    return JSON.stringify({ ...runProjection(found.run), run_id: found.run.run_id });
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, value, isError = false) {
  send({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: String(value) }], isError },
  });
}

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    callTool(params?.name, params?.arguments ?? {})
      .then((value) => reply(id, value))
      .catch((error) => reply(id, error?.message ?? error, true));
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
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

setTimeout(() => void recoverRunningRuns(), 100);
