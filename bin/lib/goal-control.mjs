import { newRun, newRunToken, readRun, runProjection, withRunLock, writeRun } from "./goal-state.mjs";
import { bootstrapPrompt, continuationPrompt, publishGoal } from "./goal-bridge.mjs";

export const GOAL_ACTIONS = ["view", "set", "clear", "edit", "pause", "resume", "cancel"];

export function parseGoalArgument(argument = "") {
  const text = String(argument).trim();
  if (!text) return { action: "view" };
  const match = /^(clear|edit|pause|resume|cancel)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return { action: "set", objective: text };
  if (match[1] !== "edit" && match[2]) throw new Error(`${match[1]} does not accept an objective`);
  return { action: match[1], ...(match[2] ? { objective: match[2].trim() } : {}) };
}

function objectiveText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 4000) throw new Error("Goal objective must contain 1–4000 characters");
  return text;
}

/** Commands and Agent tools share one serialized lifecycle boundary. */
export async function controlGoal({ root, host, conversationId, branchId, action = "view", objective, run: token, command = false }) {
  if (!conversationId || !branchId) throw new Error("conversation and branch context are required");
  if (!GOAL_ACTIONS.includes(action)) throw new Error(`Unknown Goal action: ${action}`);
  return withRunLock(root, conversationId, branchId, async () => {
    let current = readRun(root, conversationId, branchId);
    // Lifecycle changes invalidate calls still carrying an older token.
    if (!command && action !== "view" && current && token !== current.run_id) {
      throw new Error("Read the current Goal and pass its run_id before changing it");
    }
    if (token && current?.run_id !== token) throw new Error("No Goal matches this branch and run token");
    const exists = current && current.status !== "cleared";
    if (!["set", "view", "clear"].includes(action) && !exists) {
      throw new Error("No Goal exists on this branch; start /goal <objective>");
    }
    if (action === "view") {
      if (command && exists) {
        // The command produces a confirmation turn, not a work turn. Keep
        // recovery quiet until explicit resume or a substantive progress update.
        current.continuation_enabled = false;
        current.wake_pending = false;
        writeRun(root, current);
      }
    } else if (action === "set") {
      current = newRun({ conversationId, objective: objectiveText(objective) });
      current.branch_id = branchId;
    } else if (action === "clear") {
      current = newRun({ conversationId, objective: "" });
      current.branch_id = branchId;
      current.status = "cleared";
      current.continuation_enabled = false;
    } else {
      if (action === "resume") {
        if (!["paused", "blocked", "running"].includes(current.status)) {
          throw new Error(`Cannot resume a ${current.status} Goal; set a new objective`);
        }
        current.status = "running";
        current.continuation_enabled = true;
      } else if (action === "edit") {
        if (["cancelled", "failed"].includes(current.status)) {
          throw new Error(`Cannot edit a ${current.status} Goal; set a new objective`);
        }
        if (objective !== undefined) {
          current.objective = objectiveText(objective);
          current.todos = current.todos.map(todo => ({ ...todo, status: "pending" }));
          current.summary = null;
        }
        current.status = "paused";
        current.continuation_enabled = false;
      } else if (action === "pause") {
        if (!["running", "paused", "blocked"].includes(current.status)) {
          throw new Error(`Cannot pause a ${current.status} Goal`);
        }
        current.status = "paused";
        current.continuation_enabled = false;
      } else {
        current.status = "cancelled";
        current.continuation_enabled = false;
      }
      current.run_id = newRunToken();
      current.wake_pending = false;
    }
    if (action !== "view") {
      writeRun(root, current);
      await publishGoal(host, current);
    }
    const goal = current && current.status !== "cleared"
      ? { ...runProjection(current), run_id: current.run_id }
      : null;
    return { action, goal, run_id: current?.run_id ?? null, prompt: controlPrompt(action, current, objective) };
  });
}

function controlPrompt(action, run, objective) {
  if (action === "set") return bootstrapPrompt(run);
  if (action === "resume") return continuationPrompt(run);
  const result = run && run.status !== "cleared"
    ? JSON.stringify({ ...runProjection(run), run_id: run.run_id })
    : "No current Goal.";
  return [
    `The user requested Goal ${action}. The package has already applied this action.`,
    `Current Goal: ${result}`,
    action === "edit" && objective === undefined
      ? "The Goal is paused. Ask the user for the revised objective; apply it with the goal tool's edit action when they supply it."
      : "Briefly report the current Goal or confirm the action in the user's language.",
    "Do not call tools or perform Goal work in this confirmation turn. A paused Goal needs explicit resume; a cleared or cancelled Goal needs a new objective.",
  ].join("\n");
}
