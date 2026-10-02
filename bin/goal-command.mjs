#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createHostClient } from "./lib/openagent-host.mjs";
import { dataRoot, newRun, writeRun } from "./lib/goal-state.mjs";
import { bootstrapPrompt, publishGoal } from "./lib/goal-bridge.mjs";

const host = createHostClient();

function request() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    throw new Error(`could not read Goal command request: ${error.message}`);
  }
}

async function main() {
  const input = request();
  const conversationId = String(input?.conversation_id ?? "").trim();
  const objective = String(input?.argument ?? "").trim();
  if (!conversationId || !objective) throw new Error("conversation_id and argument are required");

  const run = newRun({ conversationId, objective });
  run.branch_id = String(input?.branch_id ?? "").trim() || null;
  writeRun(dataRoot(), run);

  await publishGoal(host, run).catch(() => {});
  process.stdout.write(bootstrapPrompt(run));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`goal command: ${error.message}\n`);
  process.exit(1);
}
