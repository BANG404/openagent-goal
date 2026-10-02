#!/usr/bin/env node

/**
 * Goal's package-owned Stop hook. Runtime only tells the package that a turn
 * ended; the package decides whether its durable run needs another turn and
 * wakes the Agent through the generic capability bridge.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHostClient, hookEvent } from "./lib/openagent-host.mjs";
import { continuationPrompt, flowProjection, publishGoal } from "./lib/goal-bridge.mjs";
import { dataRoot, isTerminal, readRun, writeRun } from "./lib/goal-state.mjs";

export function readHookInput(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`could not read hook payload: ${error.message}`);
  }
}

export async function continueFromStop(payload, { root = dataRoot(), client = createHostClient() } = {}) {
  const event = hookEvent(payload);
  const conversationId = String(event.conversation_id ?? event.conversationId ?? "").trim();
  const branchId = String(event.branch_id ?? event.branchId ?? "").trim();
  if (!conversationId || !branchId) return { accepted: false, reason: "missing_context" };

  const run = readRun(root, conversationId, branchId);
  // A command or the MCP process may already have queued a continuation. The
  // durable marker makes this hook idempotent across concurrent Stop hooks.
  if (!run || isTerminal(run) || run.wake_pending) {
    return { accepted: false, reason: !run ? "missing_run" : isTerminal(run) ? "terminal" : "wake_pending" };
  }

  run.wake_pending = true;
  run.iteration += 1;
  writeRun(root, run);
  try {
    let previousOutput = "";
    try {
      const detail = await client.conversation.state(conversationId, branchId);
      const messages = Array.isArray(detail?.messages) ? detail.messages : [];
      previousOutput = [...messages].reverse().find((message) => message.role === "assistant")?.text ?? "";
    } catch {
      // A stop hook must still be able to queue the continuation if the
      // optional state projection is temporarily unavailable.
    }
    await publishGoal(client, run).catch(() => {});
    await client.agent.wake(
      {
        conv_id: conversationId,
        branch_id: branchId,
        parent_checkpoint_id: null,
        text: continuationPrompt(run, previousOutput),
        attachments: [],
        contexts: [],
        model_binding: null,
        user_message_id: null,
        assistant_message_id: null,
        hidden: true,
        flow: flowProjection(run),
      },
      { wait: false },
    );
    run.wake_pending = false;
    writeRun(root, run);
    return { accepted: true, conversationId, branchId, runId: run.run_id };
  } catch (error) {
    run.wake_pending = false;
    writeRun(root, run);
    throw error;
  }
}

async function main() {
  const payload = readHookInput(readFileSync(0, "utf8"));
  await continueFromStop(payload);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`goal stop hook: ${error.message}\n`);
    process.exitCode = 1;
  }
}
