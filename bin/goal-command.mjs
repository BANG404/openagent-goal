#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { context, createHostClient } from "./lib/openagent-host.mjs";
import { dataRoot, newRun, runProjection, writeRun } from "./lib/goal-state.mjs";

const host = createHostClient();

function request() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    throw new Error(`could not read Goal command request: ${error.message}`);
  }
}

function promptFor(run) {
  return [
    "You are running the OpenAgent Goal plugin.",
    "",
    `Original user goal:\n${run.objective}`,
    "",
    "Work toward the goal directly in the current workspace.",
    `Call update_goal with run=\"${run.run_id}\" to create a complete, concrete To-Do list before claiming completion.`,
    "Keep that list current as work progresses. Completion is derived only when it is non-empty and every item is completed.",
    "Use failed only for unrecoverable failure, or blocked when user input or external state is required.",
    "Finish this turn with a concise summary of changes, verification, and remaining work.",
  ].join("\n");
}

async function main() {
  const input = request();
  const conversationId = String(input?.conversation_id ?? "").trim();
  const objective = String(input?.argument ?? "").trim();
  if (!conversationId || !objective) throw new Error("conversation_id and argument are required");

  const run = newRun({ conversationId, objective });
  run.branch_id = String(input?.branch_id ?? "").trim() || null;
  writeRun(dataRoot(), run);

  const { branchId } = context({ _openagent: { conversation_id: conversationId, branch_id: run.branch_id } });
  await host.event.emit("plugin-flow-updated", {
    conv_id: conversationId,
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
    branch_id: branchId,
  });
  process.stdout.write(promptFor(run));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`goal command: ${error.message}\n`);
  process.exit(1);
}
