#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createHostClient } from "./lib/openagent-host.mjs";
import { dataRoot } from "./lib/goal-state.mjs";
import { controlGoal, parseGoalArgument } from "./lib/goal-control.mjs";
import { defaultLocale, errorNotice, requestLocale } from "./i18n.mjs";

let locale = defaultLocale;
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const host = createHostClient();
  try { locale = await requestLocale({}, host); } catch {}
  const result = await controlGoal({
    root: dataRoot(), host, command: true,
    conversationId: String(input.conversation_id ?? "").trim(),
    branchId: String(input.branch_id ?? "").trim(),
    ...parseGoalArgument(input.argument),
  });
  process.stdout.write(result.prompt);
} catch (error) {
  process.stderr.write(`${errorNotice(error, locale)}\n`);
  process.exitCode = 1;
}
