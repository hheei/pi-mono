# @hheei/pi-goal

Session-scoped goal commitments for Pi: one goal, an explicit autonomy budget, native settle continuation, and optional independent review executed by an owned `@hheei/pi-subagents` child.

## Usage

- `/goal start <objective>` starts a goal (native editor dialog without arguments), authorizes autonomous continuation inside the recorded budget, and delivers one visible run-bound kickoff message that prompts the model to work. It needs a selected model: without one the command refuses and writes nothing, because Pi's extension `sendMessage` cannot report a failed kickoff.
- `/goal status` prints the goal, its evidence, budget, review history, cleanup diagnostics, recovery errors, and whether the session branch is already durable.
- `/goal pause` revokes and aborts the current run before waiting for owned children; `/goal resume` starts a new run without refilling usage. New work stays blocked while an owned child's stop is unconfirmed.
- `/goal clear` records a cleared goal and stops owned review children.

The model uses the `goal` tool (`read`, `checkpoint`, `blocked`, `complete`) while a run is active. `complete` requires verification evidence; with review enabled it starts an owned reviewer child whose `VERDICT: APPROVED` or `VERDICT: REJECTED` settles the goal. A rejection is delivered exactly once as a visible native boundary message; while it is pending during the parent's streaming turn, no extra continuation is spent, and another `complete` is refused until that feedback is actually delivered. A kickoff the host deferred past its run is cancelled before it reaches the model. A rejection that arrives only after the parent turn settled pauses the goal instead of sending an unacknowledged wakeup; resume reports the findings.

## Settings

Group `goal` in `ext_settings.json` (also editable through `@hheei/pi-settings`):

| Field | Default | Meaning |
| --- | --- | --- |
| `review` | `false` | Require an independent review before a goal completes. |
| `continuations` | `8` | Autonomous continuation budget recorded at `start`. |
| `reviews` | `3` | Review attempt budget recorded at `start`. |
| `reviewAgent` | `"reviewer"` | pi-subagents agent used for the review. |

Settings are projected into the goal at `start`; they never enlarge an existing goal's budget. A missing settings file uses these defaults, while an unreadable or malformed file fails `/goal start` instead of silently disabling an explicit review policy.

Pi creates a session file on the first user or assistant message; a goal started before that is reported as not yet durable.

See [design](../../docs/architecture/pi-goal.md) and [DESIGN.md](../../DESIGN.md).
