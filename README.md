# OpenAgent Goal

The standard Agent Plugin package for OpenAgent Goal Mode. The package owns the
whole capability: continuation decisions, Goal state (objective, To-Do list,
status, and summary), `update_goal`/`read_goal`, recovery, and the display
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
turn; the MCP process owns every later wake and writes state under
`PLUGIN_DATA/runs/`.

## State

Each conversation branch gets one run, stored as JSON under
`PLUGIN_DATA/runs/`. The prompt carries a short run token as a package-owned
guard; the generic Runtime also attaches the active conversation and branch to
every MCP tool call. The server checks all three values before applying
`update_goal` or `read_goal`, so a token or state record cannot cross a
conversation branch.

Completion is derived: a run is complete only when its To-Do list is non-empty
and every To-Do is completed. A `failed`, `blocked`, or `cancelled` status is
sticky, and the model cannot declare a Goal complete over unfinished work.

## Development

This repository ships no dependencies; the command and MCP server are plain
Node scripts. Validate the package with the validator from an
[OpenAgent Plugin Kit](https://github.com/BANG404/openagent-plugin-kit)
checkout, pointing at this directory.

```bash
bun <plugin-kit>/scripts/validate-plugin.mjs .
```

Submit `/goal <objective>` after installing the package to exercise the full
path. The MCP server calls `agent.wake` with `wait: false` after each Goal
update; the host queues a wake behind an active turn and persists hidden
continuations in the checkpoint.

## License

MIT
