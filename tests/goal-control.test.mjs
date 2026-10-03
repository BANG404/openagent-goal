import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { controlGoal, parseGoalArgument } from "../bin/lib/goal-control.mjs";
import { applyGoalUpdate, readRun, writeRun } from "../bin/lib/goal-state.mjs";
import { continueFromStop } from "../bin/goal-hook.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "goal-controls-"));
  const requests = [];
  const host = {
    conversation: { setFlow: async (...args) => requests.push(args), state: async () => ({ messages: [] }) },
    event: { emit: async () => {} }, agent: { wake: async () => requests.push("wake") },
  };
  return { root, requests,
    control: args => controlGoal({ root, host, conversationId: "conversation", branchId: "branch", ...args }),
    stop: phase => continueFromStop({ event: { conversation_id: "conversation", branch_id: "branch", phase } }, { root, client: host }),
    current: () => readRun(root, "conversation", "branch"),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("Goal shared command and tool lifecycle", () => {
  test("bare inspection and exact control words are distinct from objective text", () => {
    expect(parseGoalArgument()).toEqual({ action: "view" });
    expect(parseGoalArgument("edit 新目标\n检查结果")).toEqual({ action: "edit", objective: "新目标\n检查结果" });
    expect(parseGoalArgument("pause")).toEqual({ action: "pause" });
    expect(parseGoalArgument("Pause release work")).toEqual({ action: "set", objective: "Pause release work" });
    expect(() => parseGoalArgument("resume extra")).toThrow("does not accept");
  });

  test("pause preserves progress, blocks writes and recovery, resume rotates the token", async () => {
    const f = fixture();
    try {
      const started = await f.control({ action: "set", objective: "Verify work" });
      const run = f.current();
      applyGoalUpdate(run, { todos: [{ task: "First", status: "completed", result: "verified" }, { task: "Next" }] });
      writeRun(f.root, run);
      const paused = await f.control({ action: "pause", run: started.run_id });
      expect(paused.goal.status).toBe("paused");
      expect(paused.run_id).not.toBe(started.run_id);
      expect(f.current().todos[0].result).toBe("verified");
      expect(() => applyGoalUpdate(f.current(), { status: "running" })).toThrow("paused");
      expect(await f.stop("final_completed")).toMatchObject({ accepted: false });
      await f.stop("final_cancelled");
      expect(f.current().status).toBe("paused");
      await expect(f.control({ action: "resume", run: started.run_id })).rejects.toThrow("current Goal");
      const resumed = await f.control({ action: "resume", run: paused.run_id });
      expect(resumed.goal.status).toBe("running");
      expect(resumed.run_id).not.toBe(paused.run_id);
      expect(f.requests).not.toContain("wake");
      expect(await f.stop("final_completed")).toMatchObject({ accepted: true });
    } finally { f.dispose(); }
  });

  test("edit keeps evidence but requires revalidation before completing a changed objective", async () => {
    const f = fixture();
    try {
      await f.control({ action: "set", objective: "Old objective" });
      const run = f.current();
      applyGoalUpdate(run, { todos: [{ task: "Done", status: "completed", result: "old evidence" }] });
      writeRun(f.root, run);
      const edited = await f.control({ action: "edit", objective: "New objective", run: run.run_id });
      expect(f.current()).toMatchObject({ objective: "New objective", status: "paused", todos: [{ status: "pending", result: "old evidence" }] });
      const resumed = await f.control({ action: "resume", run: edited.run_id });
      expect(resumed.goal.status).toBe("running");
      expect(resumed.prompt).toContain("checking it against the current objective");
    } finally { f.dispose(); }
  });

  test("clear leaves a durable empty tombstone and stale calls cannot recreate work", async () => {
    const f = fixture();
    try {
      const start = await f.control({ action: "set", objective: "Erase current objective" });
      const cleared = await f.control({ action: "clear", run: start.run_id });
      expect(cleared.goal).toBeNull();
      expect(f.current()).toMatchObject({ status: "cleared", objective: "", todos: [], wake_pending: false });
      expect(f.requests.at(-1)[2].state.title).toBe("");
      await f.stop("final_cancelled");
      await f.stop("final_completed");
      expect(f.current().status).toBe("cleared");
      expect(f.requests).not.toContain("wake");
      await expect(f.control({ action: "set", objective: "Stale work", run: start.run_id })).rejects.toThrow();
      const view = await f.control({ action: "view" });
      expect(view.goal).toBeNull();
      expect((await f.control({ action: "set", objective: "Fresh", run: view.run_id })).goal.title).toBe("Fresh");
      const cancelled = await f.control({ action: "cancel", run: f.current().run_id });
      await expect(f.control({ action: "resume", run: cancelled.run_id })).rejects.toThrow("cancelled");
      await expect(f.control({ action: "edit", objective: "Revive", run: cancelled.run_id })).rejects.toThrow("cancelled");
    } finally { f.dispose(); }
  });

  test("bare edit waits for input and inspection never launches Goal work", async () => {
    const f = fixture();
    try {
      expect((await f.control({ action: "view", command: true })).goal).toBeNull();
      await f.control({ action: "set", objective: "Original", command: true });
      const inspected = await f.control({ action: "view", command: true });
      expect(inspected.goal.status).toBe("running");
      expect(await f.stop("final_completed")).toMatchObject({ accepted: false });
      expect(f.current().continuation_enabled).toBe(false);
      const editing = await f.control({ action: "edit", command: true });
      expect(editing.prompt).toContain("Ask the user for the revised objective");
      expect(editing.goal.status).toBe("paused");
      expect(editing.goal.title).toBe("Original");
    } finally { f.dispose(); }
  });

  test("empty/oversize objectives and sibling branch tokens cannot mutate state", async () => {
    const f = fixture();
    try {
      await expect(f.control({ action: "set", objective: " " })).rejects.toThrow();
      await expect(f.control({ action: "set", objective: "x".repeat(4001) })).rejects.toThrow();
      const first = await f.control({ action: "set", objective: "Own branch" });
      await expect(f.control({ action: "pause", branchId: "sibling", run: first.run_id })).rejects.toThrow();
      expect(f.current().status).toBe("running");
    } finally { f.dispose(); }
  });
});
