---
name: goal
description: Use OpenAgent Goal Mode when a task needs durable objectives, progress checkpoints, or a self-correcting execution loop.
---

# Goal Mode

Goal Mode is an autonomous loop this package owns. Start it with
`/goal:goal <objective>`; the package then drives turn after turn until its own
state says the Goal is finished.

The package keeps each conversation's objective, To-Do list, status, and summary
in its own data directory. Its flow step rebuilds the model's prompt from that
state on every iteration, so the loop survives context compaction and a Runtime
restart.

While a Goal is running, record progress with the `update_goal` tool, passing
the run token the Goal prompt supplied:

- `update_goal` replaces the whole To-Do list, so pass the complete current list.
- Each To-Do's status is `pending`, `in_progress`, or `completed`.
- Completion is derived, never asserted: the Goal ends only when the To-Do list
  is non-empty and every To-Do is completed.
- Use `status: "failed"` only for unrecoverable failure, or `"blocked"` when
  user input or external state is required.
- `read_goal` returns the same projection the Goal panel shows.

Do not create a separate To-Do file for the Goal: the Goal's own To-Do list is
the durable record.
