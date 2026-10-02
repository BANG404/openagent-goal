/**
 * Small dependency-free client for the OpenAgent plugin host bridge.
 *
 * The Runtime injects the three OPENAGENT_PLUGIN_* variables into every
 * enabled plugin process.  This module intentionally contains no product
 * knowledge: a package composes these capability modules into its own state
 * machine and decides when to create conversations or wake agents.
 */

const URL_ENV = "OPENAGENT_PLUGIN_HOST_URL";
const TOKEN_ENV = "OPENAGENT_PLUGIN_HOST_TOKEN";
const ID_ENV = "OPENAGENT_PLUGIN_ID";

export class OpenAgentHostError extends Error {
  constructor(message, { status = 0, operation = "" } = {}) {
    super(message);
    this.name = "OpenAgentHostError";
    this.status = status;
    this.operation = operation;
  }
}

function requiredEnvironment(environment, name) {
  const value = String(environment?.[name] ?? "").trim();
  if (!value) throw new OpenAgentHostError(`${name} is not set`);
  return value;
}

function jsonObject(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

/**
 * Create a host client. `fetch` is injectable so package tests can exercise
 * the request contract without opening a socket.
 */
export function createHostClient({ environment = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const url = requiredEnvironment(environment, URL_ENV);
  const token = requiredEnvironment(environment, TOKEN_ENV);
  const pluginId = requiredEnvironment(environment, ID_ENV);
  if (typeof fetchImpl !== "function") throw new OpenAgentHostError("fetch is unavailable");

  async function call(operation, args = {}) {
    if (!String(operation ?? "").trim()) throw new TypeError("host operation is required");
    const requestArgs = { ...jsonObject(args, "host arguments"), plugin_id: pluginId };
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation, args: requestArgs }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true) {
      throw new OpenAgentHostError(
        String(body?.error ?? `host operation failed: ${response.status}`),
        { status: response.status, operation },
      );
    }
    return body.result;
  }

  return {
    pluginId,
    call,
    conversation: {
      create: (args) => call("conversation.create", args),
      state: (convId, branchId = undefined) => call("conversation.state", {
        conv_id: convId,
        ...(branchId === undefined ? {} : { branch_id: branchId }),
      }),
      children: (parentConvId, args = {}) =>
        call("conversation.children", { ...args, parent_conv_id: parentConvId }),
      update: (convId, patch) => call("conversation.update", { ...patch, conv_id: convId }),
      cancel: (convId) => call("conversation.cancel", { conv_id: convId }),
      delete: (convId) => call("conversation.delete", { conv_id: convId }),
      setFlow: (convId, branchId, flow) => call("conversation.flow.set", {
        conv_id: convId,
        branch_id: branchId,
        flow,
      }),
    },
    branch: {
      create: (args) => call("branch.create", args),
      list: (convId) => call("branch.list", { conv_id: convId }),
      setHead: (branchId, checkpointId) =>
        call("branch.head.set", { branch_id: branchId, checkpoint_id: checkpointId }),
      setActive: (convId, checkpointId) =>
        call("branch.active.set", { conv_id: convId, checkpoint_id: checkpointId }),
    },
    agent: {
      submit: (request, options = {}) => call("agent.submit", { ...jsonObject(request, "agent request"), ...options }),
      wake: (request, options = {}) => call("agent.wake", { ...jsonObject(request, "agent request"), ...options }),
    },
    roles: {
      list: (workspace) => call("roles.list", workspace === undefined ? {} : { workspace }),
    },
    event: {
      emit: (name, payload) => call("event.emit", { name, payload }),
    },
  };
}

/** Extract the opaque conversation context attached to an MCP tool call. */
export function context(args = {}) {
  const openagent = args?._openagent;
  return {
    conversationId: String(openagent?.conversation_id ?? args?.conversation_id ?? "").trim() || null,
    branchId: openagent?.branch_id ? String(openagent.branch_id) : null,
    workspace: String(openagent?.workspace ?? args?.workspace ?? ""),
  };
}

export function requireConversationContext(args = {}) {
  const value = context(args);
  if (!value.conversationId) throw new OpenAgentHostError("OpenAgent did not provide a conversation context");
  return value;
}
