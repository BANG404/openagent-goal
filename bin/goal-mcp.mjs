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
import { createHostClient, requireConversationContext } from "./lib/openagent-host.mjs";
import {
  applyGoalUpdate,
  canContinue,
  dataRoot,
  findRunByToken,
  readRun,
  runProjection,
  withRunLock,
  writeRunFile,
} from "./lib/goal-state.mjs";
import { continuationPrompt, flowProjection, publishGoal } from "./lib/goal-bridge.mjs";
import { controlGoal, GOAL_ACTIONS } from "./lib/goal-control.mjs";
import { defaultLocale, errorNotice, noticeText, requestLocale } from "./i18n.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "goal";
const SERVER_VERSION = "2.2.1";
const root = dataRoot();
const host = createHostClient();
const pendingWakes = new Map();

export function wakeScopeKey(conversationId, branchId) {
  return `${String(conversationId)}\u0000${branchId ?? ""}`;
}

const TOOLS = [
  {
    name: "goal",
    description: "View, set, edit, pause, resume, clear or cancel the current branch Goal. Use lifecycle mutations only when the user requests them. View returns the current run_id; pass it to mutations and use the returned new token for subsequent calls. Set starts a new objective. Edit preserves evidence, resets To-Dos for review and pauses. Resume continues in the current turn; no competing turn is queued.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: GOAL_ACTIONS },
        objective: { type: "string", minLength: 1, maxLength: 4000, description: "Required for set; optional for edit (omitting it pauses for user input)" },
        run: { type: "string", description: "Current generation token, required for mutations when state already exists" },
      },
      required: ["action"],
    },
  },
  {
    name: "update_goal",
    description:
      "Replace the Goal's complete To-Do list and record progress. Pass the current run token. Only the Stop hook continues an active Goal after this turn ends; paused, cleared or cancelled Goals reject progress updates.",
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
    name: "cancel_goal",
    description: "Stop this Goal permanently, preserving its To-Dos and results. No automatic continuation will run; start a new /goal to work again.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { run: { type: "string", description: "Run token from the Goal prompt" } },
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

async function emitProjection(run) {
  await publishGoal(host, run).catch(() => {});
}

function scheduleWake(run, branchId) {
  if (!canContinue(run)) return;
  const scheduledBranchId = run.branch_id ?? branchId ?? null;
  const key = wakeScopeKey(run.conversation_id, scheduledBranchId);
  if (pendingWakes.get(key) === run.run_id) return;
  pendingWakes.set(key, run.run_id);
  let attempt = 0;
  const tick = async () => {
    return withRunLock(root, run.conversation_id, scheduledBranchId, async () => {
      attempt += 1;
      const current = readRun(root, run.conversation_id, scheduledBranchId);
      if (!current || current.run_id !== run.run_id) {
        if (pendingWakes.get(key) === run.run_id) pendingWakes.delete(key);
        return;
      }
      if (!canContinue(current)) {
        current.wake_pending = false;
        const terminalFile = findRunByToken(root, current.run_id);
        if (terminalFile) writeRunFile(terminalFile.file, current);
        if (pendingWakes.get(key) === run.run_id) pendingWakes.delete(key);
        return;
      }
      try {
        const detail = await host.conversation.state(run.conversation_id, scheduledBranchId);
        if (detail?.phase !== "final_completed") {
          current.wake_pending = false;
          const found = findRunByToken(root, current.run_id);
          if (found) writeRunFile(found.file, current);
          if (pendingWakes.get(key) === run.run_id) pendingWakes.delete(key);
          return;
        }
        // The state lookup can yield while another command replaces this branch's
        // package run. Re-read the package source of truth before submitting so an
        // old continuation cannot wake the new run.
        const latest = readRun(root, run.conversation_id, scheduledBranchId);
        if (!latest || latest.run_id !== run.run_id || !canContinue(latest)) {
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
            flow: flowProjection(latest),
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
          let locale = defaultLocale;
          try { locale = await requestLocale({}, host); } catch {}
          const code = String(error?.code ?? error?.cause?.code ?? "UNKNOWN");
          process.stderr.write(`${noticeText("notice.wakeFailed", { conversation: run.conversation_id, code }, locale)}\n`);
          return;
        }
        setTimeout(() => void tick(), Math.min(1500, 100 + attempt * 100));
      }
    });
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
      if (!stored || stored.run_id !== parsed.run_id || !canContinue(stored)) continue;
      {
        try {
          const detail = await host.conversation.state(
            stored.conversation_id,
            stored.branch_id ?? undefined,
          );
          // Approval and cancellation are durable pauses, never recovery wakes.
          if (detail?.phase !== "final_completed") continue;
        } catch {
          continue;
        }
      }
      scheduleWake(stored, stored.branch_id || null);
    } catch {
      // A malformed package state file is ignored; the next command can repair it.
    }
  }
}

async function callTool(name, args) {
  const { conversationId, branchId } = conversationContext(args);
  if (name === "goal" || name === "cancel_goal") {
    const result = await controlGoal({ root, host, conversationId, branchId,
      action: name === "cancel_goal" ? "cancel" : args.action,
      objective: args.objective, run: args.run,
    });
    if (result.action !== "view") pendingWakes.delete(wakeScopeKey(conversationId, branchId));
    // The calling Agent continues set/resume in its owning turn. The hook
    // takes over only after normal completion, preserving pending approvals.
    return JSON.stringify({ action: result.action, goal: result.goal, run_id: result.run_id,
      ...(result.action === "set" || result.action === "resume" ? { instruction: result.prompt } : {}) });
  }
  return withRunLock(root, conversationId, branchId, async () => {
    if (name === "update_goal") {
      const found = resolveRun(args);
      applyGoalUpdate(found.run, args ?? {});
      found.run.iteration += 1;
      writeRunFile(found.file, found.run);
      await emitProjection(found.run);
      return JSON.stringify({ ...runProjection(found.run), run_id: found.run.run_id });
    }
    if (name === "read_goal") {
      const found = resolveRun(args);
      return JSON.stringify({ ...runProjection(found.run), run_id: found.run.run_id });
    }
    throw new Error(`Unknown tool: ${name}`);
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function methodNotFound(id, method) {
  const respond = (locale) => send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: noticeText("notice.methodMissing", { method }, locale) },
  });
  void requestLocale({}, host).then(respond).catch(() => respond(defaultLocale));
}
function serverError(error) {
  const report = (locale) => process.stderr.write(`${errorNotice(error, locale)}\n`);
  void requestLocale({}, host).then(report).catch(() => report(defaultLocale));
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
      .catch(async (error) => {
        let locale = defaultLocale;
        try { locale = await requestLocale(params?.arguments ?? {}, host); } catch {}
        reply(id, errorNotice(error, locale), true);
      });
    return;
  }
  if (id !== undefined) methodNotFound(id, method);
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
        serverError(error);
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));

setTimeout(() => void recoverRunningRuns(), 100);
