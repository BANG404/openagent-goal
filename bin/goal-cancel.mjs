#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createHostClient } from "./lib/openagent-host.mjs";
import { dataRoot, readRun, withRunLock, writeRun } from "./lib/goal-state.mjs";
import { publishGoal } from "./lib/goal-bridge.mjs";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const conversationId = String(input.conversation_id ?? "").trim();
  const branchId = String(input.branch_id ?? "").trim();
  if (!conversationId || !branchId) throw new Error("conversation_id and branch_id are required");
  await withRunLock(dataRoot(), conversationId, branchId, async () => {
    const run = readRun(dataRoot(), conversationId, branchId);
    if (!run) throw new Error("No Goal exists on this branch");
    run.status = "cancelled";
    run.wake_pending = false;
    writeRun(dataRoot(), run);
    await publishGoal(createHostClient(), run);
  });
  process.stdout.write("The user has cancelled this Goal. Its durable status is cancelled and its existing To-Dos and results are preserved. Briefly confirm the cancellation in the user's language. Do not call tools or resume the Goal.");
} catch (error) {
  process.stderr.write(`goal cancel: ${error.message}\n`);
  process.exitCode = 1;
}
