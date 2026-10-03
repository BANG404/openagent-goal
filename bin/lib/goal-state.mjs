/**
 * Goal state, owned by this package.
 *
 * The package owns the entire Goal loop. OpenAgent only executes turns and
 * exposes the generic host bridge; this state file is the package's source of
 * truth and survives Runtime restarts.
 *
 * A run is keyed by conversation and branch. A conversation can contain several
 * independent user branches, so package state must never let one branch replace
 * another. The command learns both values from the turn payload and mints a
 * short run token as a package-owned guard. The Runtime attaches the active
 * conversation and branch to MCP calls; the server uses that context together
 * with the token when resolving a run.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TODO_STATUSES = ["pending", "in_progress", "completed"];
/** Statuses a package may set directly; `completed` is always derived. */
export const FINAL_STATUSES = ["failed", "blocked", "cancelled"];
export const RUN_STATUSES = ["running", "completed", ...FINAL_STATUSES];

/** How many finished runs to keep before pruning the oldest. */
const KEPT_RUNS = 50;

export function dataRoot(env = process.env) {
  const root = (env.PLUGIN_DATA ?? "").trim();
  if (root === "") {
    throw new Error(
      "PLUGIN_DATA is not set, so this package has nowhere to keep its goal state. " +
        "OpenAgent exports it as the package's own writable directory; set it to a " +
        "writable empty directory to run this package outside OpenAgent.",
    );
  }
  return root;
}

function runsDir(root) {
  return path.join(root, "runs");
}

/** File name for one conversation's run. Hashed so no conversation id can escape the directory. */
function branchKey(branchId) {
  return typeof branchId === "string" && branchId.trim() !== "" ? branchId.trim() : null;
}

function runFile(root, conversationId, branchId = null) {
  const key = `${String(conversationId)}\u0000${branchKey(branchId) ?? ""}`;
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(runsDir(root), `${digest}.json`);
}

/** Files written by versions that only scoped a run to its conversation. */
function legacyRunFile(root, conversationId) {
  const digest = createHash("sha256").update(String(conversationId)).digest("hex");
  return path.join(runsDir(root), `${digest}.json`);
}

export function newRunToken() {
  return randomBytes(4).toString("hex");
}

export function newRun({ conversationId, objective }) {
  return {
    run_id: newRunToken(),
    conversation_id: String(conversationId),
    branch_id: null,
    objective: objective.trim(),
    todos: [],
    status: "running",
    summary: null,
    iteration: 0,
    updated_at: Date.now(),
    wake_pending: false,
  };
}

/**
 * Derive the run status the way Goal Mode defines it: a Goal is complete only
 * once its To-Do list is non-empty and every To-Do is completed. A failure the
 * model reported is sticky.
 */
export function reconcileRun(run) {
  if (FINAL_STATUSES.includes(run.status)) {
    return run;
  }
  const settled = run.todos.length > 0 && run.todos.every((todo) => todo.status === "completed");
  run.status = settled ? "completed" : "running";
  return run;
}

export function isTerminal(run) {
  return FINAL_STATUSES.includes(run.status) || run.status === "completed";
}

export function readRun(root, conversationId, branchId = null) {
  const requestedBranch = branchKey(branchId);
  const file = runFile(root, conversationId, requestedBranch);
  const candidates = [file];
  const legacy = legacyRunFile(root, conversationId);
  if (legacy !== file) candidates.push(legacy);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const run = normalizeStoredRun(JSON.parse(readFileSync(candidate, "utf8")));
      if (run.conversation_id !== String(conversationId)) continue;
      if (branchKey(run.branch_id) !== requestedBranch) continue;
      return run;
    } catch {
      // A malformed package state file is ignored; another branch can still run.
    }
  }
  return null;
}

export function writeRun(root, run) {
  run.updated_at = Date.now();
  reconcileRun(run);
  const directory = runsDir(root);
  mkdirSync(directory, { recursive: true });
  const file = runFile(root, run.conversation_id, run.branch_id);
  writeRunFile(file, run);
  pruneRuns(directory, file);
}

/** Find the run a model addressed by token. */
export function findRunByToken(root, token) {
  const wanted = String(token ?? "").trim();
  if (wanted === "") return null;
  const directory = runsDir(root);
  if (!existsSync(directory)) return null;
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(directory, entry), "utf8"));
      if (parsed?.run_id === wanted) {
        return { run: normalizeStoredRun(parsed), file: path.join(directory, entry) };
      }
    } catch {
      // A run file the user edited by hand is not a reason to fail a tool call.
    }
  }
  return null;
}

export function writeRunFile(file, run) {
  run.updated_at = Date.now();
  reconcileRun(run);
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Serialize branch mutations across command, hook, and MCP processes. */
export async function withRunLock(root, conversationId, branchId, action) {
  const directory = runsDir(root);
  mkdirSync(directory, { recursive: true });
  const lock = `${runFile(root, conversationId, branchId)}.lock`;
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      mkdirSync(lock);
      try {
        writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), "utf8");
      } catch (error) {
        rmSync(lock, { recursive: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let abandoned = false;
      try {
        const owner = JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8"));
        try { process.kill(owner.pid, 0); } catch (error) { abandoned = error.code === "ESRCH"; }
      } catch {
        try { abandoned = Date.now() - statSync(lock).mtimeMs > 30000; } catch { continue; }
      }
      if (abandoned) {
        const stale = `${lock}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
        try { renameSync(lock, stale); rmSync(stale, { recursive: true }); } catch {}
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Goal state is busy; retry the operation");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await action();
  } finally {
    rmSync(lock, { recursive: true });
  }
}

/**
 * Apply one `update_goal` call to a run.
 *
 * The To-Do list is replaced wholesale rather than merged: the model is asked
 * for the current list every time, so a merge would let a dropped To-Do live on
 * forever.
 */
export function applyGoalUpdate(run, update) {
  if (run.status === "cancelled") throw new Error("This Goal was cancelled; start a new /goal to work again");
  if (typeof update.objective === "string" && update.objective.trim() !== "") {
    run.objective = update.objective.trim();
  }
  if (Array.isArray(update.todos)) {
    run.todos = update.todos.map((todo, index) => normalizeTodo(todo, index));
  }
  if (typeof update.summary === "string") {
    run.summary = update.summary.trim() === "" ? null : update.summary.trim();
  }
  if (typeof update.status === "string") {
    const status = update.status.trim().toLowerCase();
    if (status === "running") {
      run.status = "running";
    } else if (status === "completed") {
      // Completion is derived, never asserted: the model cannot declare victory
      // over an empty or unfinished To-Do list.
      run.status = "running";
      reconcileRun(run);
    } else if (FINAL_STATUSES.includes(status)) {
      run.status = status;
    } else {
      throw new Error(
        `update_goal status must be one of ${RUN_STATUSES.join(", ")}, got '${update.status}'`,
      );
    }
  }
  reconcileRun(run);
  return run;
}

function normalizeTodo(todo, index) {
  if (todo === null || typeof todo !== "object" || Array.isArray(todo)) {
    throw new Error(`update_goal todos[${index}] must be an object`);
  }
  const task = typeof todo.task === "string" ? todo.task.trim() : "";
  if (task === "") {
    throw new Error(`update_goal todos[${index}] requires a non-empty 'task' string`);
  }
  const status = typeof todo.status === "string" ? todo.status.trim().toLowerCase() : "pending";
  if (!TODO_STATUSES.includes(status)) {
    throw new Error(
      `update_goal todos[${index}].status must be one of ${TODO_STATUSES.join(", ")}, got '${todo.status}'`,
    );
  }
  return {
    id: typeof todo.id === "string" && todo.id.trim() !== "" ? todo.id.trim() : String(index + 1),
    task,
    status,
    result: typeof todo.result === "string" && todo.result.trim() !== "" ? todo.result.trim() : null,
  };
}

function normalizeStoredRun(run) {
  return {
    run_id: typeof run?.run_id === "string" ? run.run_id : newRunToken(),
    conversation_id: String(run?.conversation_id ?? ""),
    branch_id: branchKey(run?.branch_id),
    objective: typeof run?.objective === "string" ? run.objective : "",
    todos: Array.isArray(run?.todos) ? run.todos.map((todo, index) => normalizeTodo(todo, index)) : [],
    status: RUN_STATUSES.includes(run?.status) ? run.status : "running",
    summary: typeof run?.summary === "string" ? run.summary : null,
    iteration: Number.isInteger(run?.iteration) ? run.iteration : 0,
    updated_at: Number.isFinite(run?.updated_at) ? run.updated_at : Date.now(),
    wake_pending: Boolean(run?.wake_pending),
  };
}

/**
 * The display projection the Runtime carries to the UI.
 *
 * This is the whole of what the host sees: a title, a status, and a flat list.
 * The host renders it without knowing that "To-Do" or "Goal" mean anything.
 */
export function runProjection(run) {
  return {
    title: run.objective,
    status: run.status,
    items: run.todos.map((todo) => {
      const item = { id: todo.id, label: todo.task, status: todo.status };
      if (todo.result !== null) item.detail = todo.result;
      return item;
    }),
    ...(run.summary === null ? {} : { summary: run.summary }),
  };
}

function pruneRuns(directory, keep) {
  let entries;
  try {
    entries = readdirSync(directory).filter((entry) => entry.endsWith(".json"));
  } catch {
    return;
  }
  if (entries.length <= KEPT_RUNS) return;
  const byAge = entries
    .map((entry) => ({ entry, file: path.join(directory, entry) }))
    .sort((a, b) => statSync(a.file).mtimeMs - statSync(b.file).mtimeMs);
  for (const victim of byAge.slice(0, entries.length - KEPT_RUNS)) {
    if (victim.file === keep) continue;
    rmSync(victim.file, { force: true });
  }
}
