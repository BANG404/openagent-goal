---
name: goal
description: Use OpenAgent Goal Mode when a task needs durable objectives, progress checkpoints, or a self-correcting execution loop.
---

# Goal Mode

Goal Mode is an autonomous loop this package owns. Start it with
`/goal <objective>` (or `/goal:goal`); the command starts the first turn and the
package Stop hook drives later turns through the generic `agent.wake` bridge.

The package keeps each conversation's objective, To-Do list, status, and summary
in its own data directory. The MCP server rebuilds continuation prompts from
that state, so the loop survives context compaction and a Runtime restart.

While a Goal is running, record progress with the `update_goal` tool, passing
the run token the Goal prompt supplied:

- `update_goal` replaces the whole To-Do list, so pass the complete current list.
- Each To-Do's status is `pending`, `in_progress`, or `completed`.
- Completion is derived, never asserted: the Goal ends only when the To-Do list
  is non-empty and every To-Do is completed.
- Use `status: "failed"` only for unrecoverable failure, or `"blocked"` when
  user input or external state is required.
- `read_goal` returns the same projection the Goal panel shows.
- `cancel_goal` permanently stops the addressed run while preserving its list.
  Users can also use `/goal:cancel`; a cancelled run rejects further updates.
  Start a new `/goal` to work again.

Do not create a separate To-Do file for the Goal: the Goal's own To-Do list is
the durable record.

The continuation queue is owned by the package and scoped by conversation plus
branch. The Stop hook reads `event.conversation_id` and `event.branch_id` from
the nested automation payload, claims `wake_pending`, and rechecks the run
before calling the generic `agent.wake` capability. A queued wake must also
re-check its run token immediately before submission so a replaced run cannot
continue the wrong state. Progress updates never queue a competing continuation.
The Stop hook waits on `event.phase: "interrupted"`, cancels on
`"final_cancelled"`, and does not wake on `"final_failed"`. Recovery only wakes
normally completed turns. Every process serializes branch mutations through
the shared state lock, including writes after asynchronous host calls.

After each mutation the package persists its complete display projection with
the generic `conversation.flow.set` capability. Runtime never interprets Goal
fields; `PLUGIN_DATA` remains authoritative.
