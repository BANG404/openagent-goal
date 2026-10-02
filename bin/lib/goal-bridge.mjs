import { isTerminal, runProjection } from "./goal-state.mjs";

export const FLOW_ID = "plugin:goal:goal";

export function flowState(run) {
  return {
    plugin_id: "goal",
    flow_id: FLOW_ID,
    ...runProjection(run),
  };
}

export function flowProjection(run) {
  return { kind: "plugin", state: flowState(run) };
}

/** Publish the package-owned projection through the generic host bridge. */
export async function publishGoal(host, run) {
  const flow = flowProjection(run);
  if (run.branch_id) {
    await host.conversation.setFlow(run.conversation_id, run.branch_id, flow);
  }
  // Shared lifecycle events require a branch id so the host cannot apply a
  // projection to a sibling branch. A rootless legacy run remains durable in
  // PLUGIN_DATA and is picked up by the package's recovery path.
  if (run.branch_id) {
    await host.event.emit("plugin-flow-updated", {
      plugin_id: "goal",
      conv_id: run.conversation_id,
      flow_id: FLOW_ID,
      status: run.status,
      flow,
      branch_id: run.branch_id,
    });
  }
}

export function bootstrapPrompt(run) {
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

export function continuationPrompt(run, previousOutput = "") {
  const instruction = isTerminal(run)
    ? `The Goal is finished with status \"${run.status}\". Start no new work; state the final outcome.`
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
