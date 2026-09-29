#!/usr/bin/env node

/**
 * The Goal package's flow step.
 *
 * OpenAgent owns the flow loop but none of its decisions: on every iteration it
 * runs this step with the run's identity and the previous turn's output on
 * stdin, then runs the turn this step's `prompt` describes. The step reports
 * `done` from the state the previous turn left behind, so the package — not the
 * host — decides when a Goal is finished.
 *
 * This step is the only place a run is created; the model's `update_goal` call
 * only ever replaces the To-Do list of the run this step already made.
 */

import { readFileSync } from "node:fs";
import {
  dataRoot,
  isTerminal,
  newRun,
  readRun,
  reconcileRun,
  runProjection,
  writeRun,
} from "./lib/goal-state.mjs";

function readPayload() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    throw new Error(`could not read the flow step payload from stdin: ${error.message}`);
  }
}

function bootstrapPrompt(run) {
  return [
    "You are running OpenAgent /goal mode.",
    "",
    "Original user goal:",
    run.objective,
    "",
    "Persisted workflow requirements:",
    "1. Work toward the goal directly in the current workspace.",
    `2. Call the update_goal tool with run="${run.run_id}" to create stable, concrete To-Dos before claiming completion, and keep their status current as you work. Every update_goal call needs that exact run token.`,
    "3. The Goal completes only when the To-Do list is non-empty and every To-Do is completed. Use failed only for unrecoverable implementation failure, or blocked when user input or external state is required.",
    "4. End your assistant response with a concise summary of this single execution round: what changed, verification run, and remaining work if any.",
  ].join("\n");
}

function continuationPrompt(run, previousOutput, done) {
  const instruction = done
    ? `The Goal is finished with status "${run.status}". Start no new work; state the final outcome.`
    : run.todos.length === 0
      ? "The Goal still has no To-Dos. Call update_goal now to create a concrete, stable To-Do list before continuing."
      : "Continue the pending or in-progress To-Dos and call update_goal whenever their state changes.";
  const output = String(previousOutput ?? "").trim();
  return [
    "The Goal is still active and this user message is an OpenAgent control continuation.",
    "",
    `Record progress by calling the update_goal tool with run="${run.run_id}".`,
    "",
    "Current Goal state:",
    JSON.stringify(runProjection(run), null, 2),
    "",
    ...(output === "" ? [] : ["Previous execution output:", output, ""]),
    instruction,
    "The Goal completes only after the To-Do list is non-empty and every To-Do is completed.",
  ].join("\n");
}

function main() {
  const payload = readPayload();
  const conversationId = String(payload?.conversation_id ?? "").trim();
  if (conversationId === "") {
    throw new Error("requires a conversation_id in the flow step payload");
  }
  const iteration =
    Number.isInteger(payload?.iteration) && payload.iteration > 0 ? payload.iteration : 1;

  const root = dataRoot();
  // A new flow starts a new Goal: the run key is the conversation, so an
  // objective that was already finished must not answer the next one.
  let run = iteration === 1 ? null : readRun(root, conversationId);
  if (run === null) {
    const objective = String(payload?.argument ?? payload?.input ?? "").trim();
    if (objective === "") {
      throw new Error("needs a non-empty goal argument to start a run");
    }
    run = newRun({ conversationId, objective });
  }
  run.iteration = iteration;
  reconcileRun(run);

  const done = isTerminal(run);
  const prompt =
    iteration === 1
      ? bootstrapPrompt(run)
      : continuationPrompt(run, payload?.last_output, done);
  writeRun(root, run);

  process.stdout.write(
    `${JSON.stringify({
      prompt,
      done,
      state: {
        plugin_id: String(payload?.plugin_id ?? ""),
        flow_id: String(payload?.flow_id ?? ""),
        ...runProjection(run),
      },
    })}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`goal step: ${error.message}\n`);
  process.exit(1);
}
