import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { continueFromStop } from "../bin/goal-hook.mjs";
import { newRun, readRun, writeRun } from "../bin/lib/goal-state.mjs";

function makeRun(root, branchId, status = "running") {
  const run = newRun({ conversationId: "conversation", objective: `Goal ${branchId}` });
  run.branch_id = branchId;
  run.status = status;
  if (status === "completed") {
    run.todos = [{ id: "done", task: "Done", status: "completed", result: "ok" }];
  }
  writeRun(root, run);
  return run;
}

function fakeHost(requests, { failWake = false } = {}) {
  return {
    conversation: {
      state: async (_conversationId, branchId) => ({
        branch_id: branchId,
        messages: [{ role: "assistant", text: `previous ${branchId}` }],
      }),
      setFlow: async (...args) => requests.push({ operation: "conversation.flow.set", args }),
    },
    event: {
      emit: async (...args) => requests.push({ operation: "event.emit", args }),
    },
    agent: {
      wake: async (...args) => {
        requests.push({ operation: "agent.wake", args });
        if (failWake) throw new Error("bridge unavailable");
        return { accepted: true };
      },
    },
  };
}

describe("Goal package Stop hook", () => {
  test("reads the nested event and wakes only the selected branch", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openagent-goal-hook-"));
    try {
      const first = makeRun(root, "branch-a");
      makeRun(root, "branch-b");
      const requests = [];
      const result = await continueFromStop(
        { hook_event_name: "Stop", event: { conversation_id: "conversation", branch_id: "branch-a", turn: 4 } },
        { root, client: fakeHost(requests) },
      );
      expect(result).toMatchObject({ accepted: true, branchId: "branch-a", runId: first.run_id });
      expect(requests.filter((request) => request.operation === "agent.wake")).toHaveLength(1);
      expect(requests.find((request) => request.operation === "agent.wake").args[0].branch_id).toBe("branch-a");
      expect(readRun(root, "conversation", "branch-b").wake_pending).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is idempotent for a pending or terminal package run", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openagent-goal-hook-"));
    try {
      const pending = makeRun(root, "pending");
      pending.wake_pending = true;
      writeRun(root, pending);
      const terminal = makeRun(root, "terminal", "completed");
      const requests = [];
      expect(await continueFromStop({ event: { conversation_id: "conversation", branch_id: "pending" } }, { root, client: fakeHost(requests) })).toMatchObject({ accepted: false, reason: "wake_pending" });
      expect(await continueFromStop({ event: { conversation_id: "conversation", branch_id: "terminal" } }, { root, client: fakeHost(requests) })).toMatchObject({ accepted: false, reason: "terminal" });
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clears the durable claim when the generic wake fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openagent-goal-hook-"));
    try {
      makeRun(root, "branch");
      await expect(
        continueFromStop(
          { event: { conversation_id: "conversation", branch_id: "branch" } },
          { root, client: fakeHost([], { failWake: true }) },
        ),
      ).rejects.toThrow("bridge unavailable");
      expect(readRun(root, "conversation", "branch").wake_pending).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
