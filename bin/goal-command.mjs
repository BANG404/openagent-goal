#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createHostClient } from "./lib/openagent-host.mjs";
import { dataRoot } from "./lib/goal-state.mjs";
import { controlGoal, parseGoalArgument } from "./lib/goal-control.mjs";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const result = await controlGoal({
    root: dataRoot(), host: createHostClient(), command: true,
    conversationId: String(input.conversation_id ?? "").trim(),
    branchId: String(input.branch_id ?? "").trim(),
    ...parseGoalArgument(input.argument),
  });
  process.stdout.write(result.prompt);
} catch (error) {
  process.stderr.write(`goal command: ${error.message}\n`);
  process.exitCode = 1;
}
