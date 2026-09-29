# OpenAgent Goal

The standard Agent Plugin package for OpenAgent Goal Mode. The package owns the
whole capability: the autonomous continuation loop's decisions, the Goal state
(its objective, To-Do list, status, and summary), the `update_goal`/`read_goal`
tools, and the display projection the Goal panel renders. OpenAgent supplies
only the loop mechanics — turn dispatch, cancellation, the iteration limit, and
checkpoint continuation.

Install or update this package from its GitHub repository in OpenAgent. The
package uses the portable Agent Plugins 1.0.0 format plus the
`extensions.openagent` contract:

- `flows` declares `/goal`, whose step is `bin/goal-step.mjs`.
- `mcp.json` starts `bin/goal-mcp.mjs` as the package's stdio MCP server.
- `skills/goal` documents the loop for the model.

OpenAgent exports `PLUGIN_ROOT` and `PLUGIN_DATA` to both, so the step and the
tools share one state directory per install.

## State

Each conversation gets one run, stored as JSON under `PLUGIN_DATA/runs/`. The
prompt carries a short run token instead of the conversation, because an MCP
server runs out of process and is shared across conversations; the model echoes
that token into `update_goal`, which is how a tool call finds its run.

Completion is derived: a run is complete only when its To-Do list is non-empty
and every To-Do is completed. A `failed`, `blocked`, or `cancelled` status is
sticky, and the model cannot declare a Goal complete over unfinished work.

## Development

This repository ships no dependencies; the step and the MCP server are plain
Node scripts. Validate the package with the validator from an
[OpenAgent Plugin Kit](https://github.com/BANG404/openagent-plugin-kit)
checkout, pointing at this directory.

```bash
bun <plugin-kit>/scripts/validate-plugin.mjs .
```

To run a step by hand, feed it the payload OpenAgent would write:

```bash
PLUGIN_DATA=/tmp/goal-data node bin/goal-step.mjs <<'JSON'
{"conversation_id":"demo","plugin_id":"goal","flow_id":"goal","iteration":1,"argument":"ship it","input":"/goal ship it","last_output":""}
JSON
```

## License

MIT
