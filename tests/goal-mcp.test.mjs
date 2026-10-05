import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { newRun, readRun, writeRun } from "../bin/lib/goal-state.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const mcpScript = path.join(packageRoot, "bin", "goal-mcp.mjs");

async function startHost({ phase = "final_completed" } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    let result = {};
    if (parsed.operation === "conversation.state") {
      result = {
        phase,
        branch_id: parsed.args.branch_id ?? null,
        workspace: "",
      };
    } else if (parsed.operation === "agent.wake") {
      result = { accepted: true };
    } else if (parsed.operation === "event.emit") {
      result = { name: parsed.args.name };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function startMcp(dataRoot, hostUrl) {
  const child = spawn(process.execPath, [mcpScript], {
    cwd: packageRoot,
    env: {
      ...process.env,
      PLUGIN_DATA: dataRoot,
      OPENAGENT_PLUGIN_HOST_URL: hostUrl,
      OPENAGENT_PLUGIN_HOST_TOKEN: "test-token",
      OPENAGENT_PLUGIN_ID: "goal",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const replies = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        replies.get(message.id)?.(message);
      }
      newline = buffer.indexOf("\n");
    }
  });
  let nextId = 1;
  const request = (method, params = {}) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        replies.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 3000);
      replies.set(id, (message) => {
        clearTimeout(timeout);
        replies.delete(id);
        resolve(message);
      });
    });
  };
  await request("initialize", { protocolVersion: "2024-11-05" });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  return {
    child,
    callTool: (name, args) => request("tools/call", { name, arguments: args }),
    stop: () => new Promise((resolve) => {
      child.once("close", resolve);
      child.kill();
    }),
  };
}

function makeRun(dataRoot, conversationId, branchId) {
  const run = newRun({ conversationId, objective: `Goal ${branchId}` });
  run.branch_id = branchId;
  writeRun(dataRoot, run);
  return run;
}

function updateArgs(conversationId, branchId, runId) {
  return {
    _openagent: { conversation_id: conversationId, branch_id: branchId, workspace: "" },
    run: runId,
    todos: [{ id: "work", task: `Work on ${branchId}`, status: "in_progress" }],
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition did not become true before timeout");
}

describe("Goal package wake scheduling", () => {
  test("Agent lifecycle tool exposes every command operation without competing wakes", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-goal-"));
    const host = await startHost();
    const mcp = await startMcp(dataRoot, host.url);
    const _openagent = { conversation_id: "conversation", branch_id: "branch", workspace: "" };
    const control = async (action, extra = {}) => {
      const response = await mcp.callTool("goal", { action, _openagent, ...extra });
      expect(response.result.isError).toBe(false);
      return JSON.parse(response.result.content[0].text);
    };
    try {
      await new Promise(resolve => setTimeout(resolve, 160));
      expect((await control("view")).goal).toBeNull();
      let state = await control("set", { objective: "Tool objective" });
      await mcp.callTool("update_goal", updateArgs("conversation", "branch", state.run_id));
      state = await control("pause", { run: state.run_id });
      expect(state.goal.status).toBe("paused");
      state = await control("edit", { run: state.run_id, objective: "Revised objective" });
      expect(state.goal.title).toBe("Revised objective");
      state = await control("resume", { run: state.run_id });
      expect(state.goal.status).toBe("running");
      state = await control("clear", { run: state.run_id });
      expect(state.goal).toBeNull();
      expect((await control("view")).run_id).toBe(state.run_id);
      expect(host.requests.filter(request => request.operation === "agent.wake")).toHaveLength(0);
    } finally {
      await mcp.stop(); await host.close(); rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("startup recovery ignores paused, cleared and inspection-suppressed states", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-goal-"));
    const host = await startHost();
    for (const status of ["paused", "cleared", "running"]) {
      const run = makeRun(dataRoot, "conversation", status);
      run.status = status;
      run.continuation_enabled = false;
      writeRun(dataRoot, run);
    }
    const mcp = await startMcp(dataRoot, host.url);
    try {
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(host.requests.filter(request => request.operation === "agent.wake")).toHaveLength(0);
    } finally {
      await mcp.stop(); await host.close(); rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("progress updates do not queue a competing wake on sibling branches", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-goal-"));
    const host = await startHost();
    const mcp = await startMcp(dataRoot, host.url);
    try {
      // Let startup recovery inspect an empty package directory first.
      await new Promise((resolve) => setTimeout(resolve, 160));
      const first = makeRun(dataRoot, "conversation", "branch-a");
      const second = makeRun(dataRoot, "conversation", "branch-b");
      await Promise.all([
        mcp.callTool("update_goal", updateArgs("conversation", "branch-a", first.run_id)),
        mcp.callTool("update_goal", updateArgs("conversation", "branch-b", second.run_id)),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(
        host.requests
          .filter((request) => request.operation === "agent.wake")
          .map((request) => request.args.branch_id)
          .sort(),
      ).toEqual([]);
      expect(host.requests.filter((request) => request.operation === "conversation.flow.set")).toHaveLength(2);
    } finally {
      await mcp.stop();
      await host.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("cancel_goal preserves progress and rejects later updates", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-goal-"));
    const host = await startHost();
    const mcp = await startMcp(dataRoot, host.url);
    try {
      await new Promise((resolve) => setTimeout(resolve, 160));
      const run = makeRun(dataRoot, "conversation", "branch");
      const args = updateArgs("conversation", "branch", run.run_id);
      await mcp.callTool("update_goal", args);
      const cancelled = await mcp.callTool("cancel_goal", { run: run.run_id, _openagent: args._openagent });
      expect(cancelled.result.isError).toBe(false);
      expect(readRun(dataRoot, "conversation", "branch")).toMatchObject({ status: "cancelled", todos: [{ id: "work" }], wake_pending: false });
      const translated = await mcp.callTool("update_goal", {
        ...args,
        _openagent: { ...args._openagent, locale: "zh" },
      });
      expect(translated.result.isError).toBe(true);
      expect(translated.result.content[0].text)
        .toBe("此会话分支中没有与该运行令牌匹配的 Goal");
      expect(host.requests.filter((request) => request.operation === "agent.wake")).toHaveLength(0);
    } finally {
      await mcp.stop();
      await host.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("drops a queued wake when the branch run token is replaced", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-goal-"));
    const host = await startHost();
    makeRun(dataRoot, "conversation", "branch");
    const mcp = await startMcp(dataRoot, host.url);
    try {
      await waitFor(() => host.requests.some((request) => request.operation === "conversation.state"));
      // Replace the package-owned run before the scheduled tick reaches the
      // host. The old continuation must not wake the replacement run.
      await new Promise((resolve) => setTimeout(resolve, 20));
      makeRun(dataRoot, "conversation", "branch");
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(host.requests.filter((request) => request.operation === "agent.wake")).toHaveLength(0);
    } finally {
      await mcp.stop();
      await host.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("startup recovery leaves an interrupted approval untouched", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-goal-"));
    const host = await startHost({ phase: "interrupted" });
    const run = makeRun(dataRoot, "conversation", "branch");
    const mcp = await startMcp(dataRoot, host.url);
    try {
      await waitFor(() => host.requests.some((request) => request.operation === "conversation.state"));
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(host.requests.filter((request) => request.operation === "agent.wake")).toHaveLength(0);
      expect(readRun(dataRoot, "conversation", "branch").run_id).toBe(run.run_id);
    } finally {
      await mcp.stop();
      await host.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
