# OpenAgent Goal

The standard Agent Plugin package for OpenAgent Goal Mode. The package owns the
whole capability: continuation decisions, Goal state (objective, To-Do list,
status, and summary), lifecycle controls, progress tools, recovery, and the display
projection. OpenAgent supplies only the generic host bridge and one ordinary
Agent execution boundary. The package uses the same conversation, branch,
Agent wake, role, and event modules as every other plugin.

Install or update this package from its GitHub repository in OpenAgent. The
package uses the portable Agent Plugins 1.0.0 format plus the
`extensions.openagent` contract. It is an ordinary package; the Runtime does
not select or implement Goal behavior:

- `commands` declares the `goal` command. The generic package-id alias exposes
  it as `/goal`; `/goal:goal` remains routable as its full name.
- `mcp.json` starts `bin/goal-mcp.mjs` as the package's stdio MCP server.
- `skills/goal` documents the loop for the model.

OpenAgent exports `PLUGIN_ROOT`, `PLUGIN_DATA`, and the authenticated host
bridge variables to every package process. The command starts the first Agent
turn; the package's Stop automation hook owns later wake decisions through the
generic `agent.wake` capability. The MCP process keeps a small recovery
fallback for a package restart. Progress tools do not queue another turn while
the current turn is executing or waiting for approval. Recovery only wakes a
normally completed turn; interrupted turns wait for the user's answer.

## State

Use `/goal [<objective>|clear|edit|pause|resume]`: bare `/goal` shows status,
`pause` retains progress, `resume` continues, and `clear` removes the current
objective. `/goal edit <objective>` pauses with the revised target and retains
results for revalidation; bare `edit` asks for the new target. Agent tools expose
the same actions through `goal({ action, objective?, run? })`. Read the current
token with `action: "view"` before mutating existing state. See the bundled
Goal skill for lifecycle authority and continuation rules.

Each conversation branch gets one run, stored as JSON under
`PLUGIN_DATA/runs/`. The prompt carries a short run token as a package-owned
guard; the generic Runtime also attaches the active conversation and branch to
every MCP tool call. The server checks all three values before applying
`update_goal` or `read_goal`, so a token or state record cannot cross a
conversation branch.

Completion is derived: a run is complete only when its To-Do list is non-empty
and every To-Do is completed. A `failed`, `blocked`, or `cancelled` status is
sticky, and the model cannot declare a Goal complete over unfinished work.

## Stop a Goal

Use `/goal:cancel` to cancel the current branch's Goal, or `cancel_goal` with
its run token. The command changes durable state before asking the Agent to
confirm; it does not rely on a model tool call. The composer's Stop action also
cancels the Goal when the Runtime reports `final_cancelled` to its Stop hook.
Cancelled Goals retain their To-Dos and results, reject subsequent progress
updates, and never auto-resume after restarting the package. Start a new
`/goal <objective>` to begin again.

The Stop hook consumes the generic lifecycle `phase`: `interrupted` waits for
approval/input, `final_cancelled` cancels, and `final_failed` does not wake.
All command, hook, MCP, and recovery state mutations serialize through a
per-branch filesystem lock and atomically replace the JSON file. A hook cannot
overwrite progress recorded during an asynchronous host request.

## Development

This repository ships no dependencies; the command and MCP server are plain
Node scripts. Validate the package with the validator from an
[OpenAgent Plugin Kit](https://github.com/BANG404/openagent-plugin-kit)
checkout, pointing at this directory.

```bash
bun <plugin-kit>/scripts/validate-plugin.mjs .
bun test
```

Submit `/goal <objective>` after installing the package to exercise the full
path. When a turn stops, `bin/goal-hook.mjs` reads the nested hook event,
rechecks the conversation and branch run, and calls `agent.wake` with
`wait: false`; the host queues the hidden continuation behind an active turn.
The durable `wake_pending` marker guards a pending continuation; normal MCP
progress updates never queue another turn alongside the Stop hook.

Wake scheduling is keyed by conversation and branch. Before a queued wake is
submitted, the package re-reads the branch run token, so replacing a run cannot
make an older continuation advance the new run.

The package also calls the generic `conversation.flow.set` capability after
each state mutation. The host stores only the opaque display projection; the
Goal files remain the package's source of truth.

## Language support

The package declares English and Chinese in `plugin.json`. OpenAgent supplies
the current application language to each MCP call and through `locale.get` for
commands and hooks. Plugin metadata, slash-command labels, validation errors,
and operational notices follow that language. Goal IDs, lifecycle status
values, user objectives, To-Dos, and historical results keep their original
values.

## License

MIT

## MCP mounting and plugin name

The manifest declares `mcp_tool_mode: direct`. Tools are available immediately
for lifecycle operations.
Users may select Direct, Relay, or Follow plugin declaration in OpenAgent
Settings; the override applies to every server in this package.
The English and Chinese display names follow the application language; the
package ID, commands, tool names and persisted state remain stable.
