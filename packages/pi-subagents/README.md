# @hheei/pi-subagents

Run several independent Pi child sessions from one Pi session, each with its own Pi session
file, its own runtime, and its own durable identity.

The package is a single concrete extension with one `pi.extensions` entry
(`dist/extension.js`). The same entry runs on both sides: the parent branch registers the
model-facing tools, commands, compact footer status, and info entries; the child branch registers only the reporting
bridge and session-leave reporting.

## Parent tools

The extension registers no global keyboard shortcuts. Use `/subagents` to manage
children and `/subagents stop [id]` to stop one without conflicting with other extensions.

| Tool | Purpose |
| --- | --- |
| `agents_delegate({ task, agent?, id?, cwd?, wait? })` | Delegate work to a new agent (`agent`) or continue an existing one (`id`, which wins over `agent`). Omit `id` to create an agent: Pi assigns the id, so an unknown or blank id is never a way to create one. A new child runs in a new Herdr tab, cmux surface, or Rex window (beside the parent's own pane or in the parent's session) when a host is available, and headless in the background otherwise. **Prefer reusing existing agents** via `id` for related/follow-up work to keep context and maximize prompt-cache and memory efficiency. The tool description lists available agent names and roles, excluding disabled or hidden definitions. Deferred by default; discover via `tool_search({ query: "agent" })`. `wait:true` (default) returns the settled delegation, `wait:false` returns it as soon as it is accepted; either way the result arrives automatically, so do not poll. |
| `agents_get({ id, revision?, includeOutput? })` | Read one delegation of an agent: the newest by default, `revision` for one specific delegation, and the result body only with `includeOutput: true` (bounded by the shared output limit). The view carries the delegation `status` and the runtime `progress.runtimeState` separately, so a new delegation never overwrites a historical result. From the second successful inspection of the same agent in this parent runtime, the result adds a short reminder that results return automatically and must not be polled. Deferred by default; discover via `tool_search({ query: "agent" })`. |
| `agents_stop({ id })` | Stop one agent's runtime by id. Open delegations end as failed; finished results and the session are kept, so a later `agents_delegate` with this id resumes it. Deferred by default; discover via `tool_search({ query: "agent" })`. |
| `agents_dashboard({})` | Summarise this session's agents: runtime counts plus each agent's latest delegation status and activity, never result bodies. Deferred by default; discover via `tool_search({ query: "agent" })`. |

### Unified Task Management

`agents_delegate` returns `{ id, revision, status, task, hasOutput }`: `revision` identifies that
delegation of the agent, and a settled delegation carries its result when `wait` is true.
`agents_stop` returns the same projection for the agent it stopped. Failures return only their
reason. There is no public `title` or `mode`: the child session title is derived from the agent name
and id, and continuing an agent always steers.

SubagentManager and its SQLite ledger own child conversation state, runtime leases, recovery, and reports. No pi-ext-tools task service is required. Only delivery batching is shared through ext-core BackgroundDelivery. Child reports arrive automatically; do not poll status to detect completion. Bash uses separate `bg_bash_*` tools. Deferred agent tools are loaded via `tool_search`; `before_agent_start` writes the `subagents` bullet into the structured prompt's `optional_tools` section. Diagnostics describe blockers, failed turns, or uncertain runtime state.

## Owned scopes (`@hheei/pi-subagents/ownership`)

A consumer that must end exactly the work it started (pi-goal's independent review) opens an owned
scope instead of calling the tools itself. The subpath has no registration side effect: importing it
only gives access to the service key and its types.

```ts
const service = getService(pi, SUBAGENT_OWNERSHIP_SERVICE); // immediate lookup, may be undefined
const scope = service?.openScope(`${runId}:review:${attempt}`);
const handle = await scope.delegate({ agent: "reviewer", task }, ctx, signal); // ctx: the calling tool's
const { status, message } = await handle.settlement;                          // ExtensionToolContext
const close = await scope.close("goal paused"); // { closed, failures }
```

Contract:

- **Tool pipeline, not a private dispatch.** `delegate` runs the registered `agents_delegate` tool
  through `ctx.executeTool`, so validation, tool hooks and permissions are the same ones a model
  call gets. `ctx` is used for that call and never retained; `signal` cancels the call.
- **Ownership is bound to the call.** The owner travels on the dispatch's own signal rather than in
  the tool arguments, so a `tool_call` hook that rewrites the arguments can neither drop an owner
  (the child stays owned and is still stopped by `close`) nor invent one (the call is refused before
  anything is launched). A request that names an owner without that binding is refused, not run.
- **Owned work is headless.** An owned delegation always asks for background placement, so the
  reviewer runs without a panel even when the native probe found a presentation host. Ordinary
  delegations keep their automatic placement.
- **A scope owns an identity, not a child.** The owner id is the caller's; opening the same id again
  while its scope is live returns that scope. A cleaned scope leaves the registry, so a later
  attempt can open the same owner id again. A scope with unconfirmed cleanup stays and refuses new
  work until a retried `close()` confirms it.
- **An owned turn always creates a new child.** There is no way to claim an agent a human started;
  `id` is refused with an owner token, and an owned child is not available to `agents_delegate`,
  steering, or MCP reuse while the claim is live.
- **Durable before the child exists.** The claim is written to `state.sqlite` (`owned_children`)
  during the launch reservation, before bootstrap or spawn, together with the provider incarnation
  that recorded it. That incarnation holds its own lock under `locks/owners/`; a child's writer lock
  is not evidence about its owner.
- **The ledger is read at every decision.** Claims are never decided from a startup snapshot: a
  child another provider claims *after* this one recovered is still recognized as owned, so this
  provider will not stop, reuse, or report on work a live owner holds. A retained foreign claim is
  re-read against the owner's own lock on every decision and every recovery retry: a confirmed free
  lock means that owner will never clean up, so the row becomes an orphan this provider stops
  through the same confirmed path before the child is free again. The child's own writer lock is
  never evidence about its owner — the child outlives the provider that started it. The same
  reading releases
  the opposite: a recovered claim is only a view of the owner's durable row, so when that row is
  gone the child is ordinary here again — reusable, stoppable, and its next report reaches the
  parent conversation. Ownership this provider took on itself is never dropped that way: an
  adopted child stays its cleanup responsibility even if the row disappears.
- **Crash recovery stops instead of adopting.** A provider start claims every owned row of its
  session. Rows whose owner lock is free are orphans: they are stopped and their claims retired,
  and they are never reopened, adopted, or reported as ordinary children. Rows whose owner lock is
  held belong to a live provider: they are left running and are never taken over. A child that
  cannot be confirmed stopped keeps its claim, stays unavailable, and is retried by the next
  recovery.
- **A report is not the end of a runtime.** The owner's settlement is routed out of the parent
  conversation, but `close()` still stops every child it owns and drops the claim only after the
  stop is confirmed. A late report of a retired child is consumed; once the child is given new work
  by anyone else, its reports reach the parent again.
- **Closing is synchronous first.** `close()` marks the scope closed before its first `await`, so a
  dispatch that has not reserved yet is refused, and a dispatch already in flight is drained (its
  claim is then stopped) rather than left behind. A failed stop is reported in `failures` and is
  retried by calling `close()` again; a successful close is final.
- **An explicit human stop stays allowed.** `agents_stop` on an owned child ends it and settles the
  owner's wait as `stopped`; it is refused only when another live provider incarnation owns the
  child.
- **Teardown order is internal.** Provider shutdown closes owned scopes before it releases local
  connections, in one resource, so extension teardown order cannot leave an owned child talking to
  a closed transport.

## Child execution and reporting

Subagents communicate with the parent through the `commands` table in `state.sqlite`, with each child holding a SQLite process lock that proves its writer is alive:

- **Completion by Direct Output**: Subagents do **not** need to call any reporting tool upon successful completion. The subagent simply outputs its final answer as normal assistant text.
- **Settlement Batching**: When a subagent settles, the harness captures the trailing assistant text and delivers it to the parent conversation as a `subagent-report`. Reports flush within 500ms when no other child is working, and are batched for up to 10 seconds while another child is still running.
- **Blockers & Decisions**: The child registers `contact_parent({ message, reason? })` strictly for reporting when it is blocked or urgently requires a parent decision midway (`reason` defaults to `'blocked'`). Blocked reports wake the parent immediately.
- **Direct `/compact` Command**: Sending `"/compact"` (or `"/compact [instructions]"`) via `agents_delegate` intercepts the command on the child side without passing it as prompt text to the LLM. The child executes native context compaction and reports completion status back to the parent via `contact_parent`. Duplicate `/compact` requests while a compaction is already in flight are safely acknowledged and ignored.
- **Context Trim Hint**: When a subagent completes a task with context usage exceeding 100,000 tokens, its report includes a hint advising the parent to trim memory via `agents_delegate({ id, task: "/compact" })` if the child session will be retained for future work.
- **Automatic Retry**: Pi's own auto-retry is observed, not invented: reports are suppressed while a retry is in flight, and a retry that succeeds clears the previous error instead of reporting it.
- **Panel Failure Auto-Close**: When a subagent running in a panel encounters a fatal error or reports a blocker, the manager starts a 15-second countdown after notifying the parent, automatically closing the panel tab to avoid workspace clutter unless new instructions are dispatched.
## Compact status and reports

Running children use the native Pi status line: `agents xN` (e.g. `agents x3`). With pi-status installed, this appears at the bottom right before the existing TODO segment, separated by ` ‧ `. No running children means no agent segment; no multi-line parent widget is mounted.

Confirmed done, error, and blocked reports appear once as `subagent-info` transcript entries. Collapsed entries show the outcome, child ID, and agent name; expand to read the complete report. They survive resume and do not enter model context. The original automatic `subagent-report` still reaches the model, with its duplicate transcript display hidden. Transient errors remain subject to settlement and retry checks before reporting.

Use `/subagents` for complete status and management. `agents_delegate` with an existing `id` can resume a done, blocked, errored, or stopped child with its session context intact; retrying does not guarantee the underlying failure is resolved.

## Host Integration and Isolation

- **A Panel Host Is Chosen By Fact**: Herdr, cmux, and Rex are probed in that order. A host is only
  chosen when it can prove this process runs in one of its containers: Herdr from
  `herdr pane process-info`, Rex from `rex block call process` (`REX_BLOCK` is a hint, never the
  answer). cmux has no such query and answers with its own ping. No host means a headless child.
- **Herdr Attachment Is A Fact**: A pane is only this parent's pane when the kernel says so — one of the pane's foreground processes (`herdr pane process-info`) must be this process or one of its ancestors, and only then is a tab created there (`--workspace <WORKSPACE_ID>`). The pane's own shell does not count, so `pi &` stays out. Inherited `HERDR_ENV`/`HERDR_PANE_ID` merely order the candidates, and `herdr pane current --current` (which answers where a human is looking) is never used as identity. No match means no panel and a headless child.
- **Panel Failures Degrade**: When the panel cannot be opened and no explicit `panel` presentation was requested, the child runs in the background and the spawn result says why. Host error codes are surfaced instead of being folded into a generic message.
- **Memory Isolation**: Both `PI_HINDSIGHT_DISABLE=1` and `PI_OBSERVATIONAL_MEMORY_DISABLE=1` are injected into child processes. Hindsight memory auto-registration, recall, and writeback are disabled, and the child bridge blocks all `mcp__hindsight__*` calls. Background Observational Memory workers (observation, reflection, compaction triggers) are suppressed in passive mode.

## Agent definitions

Agent Markdown files are discovered in this order, most specific first, by `name`:

```text
<cwd>/.pi/agents/*.md
<cwd>/.pi/agents/*.md
~/.pi/agent/agents/*.md
```

Frontmatter is parsed with Pi's `parseFrontmatter` and validated against this package's schema. Supported fields: `name`, `display_name`, `description`, `hidden`, `model`, `thinking`, `tools`, `exclude_tools`, `extensions`, `skills`, `mcp`, `codemode`.

### Unified Resource Selection (Pi Semantics)

`tools`, `skills`, and `mcp` follow Pi's unified selection semantics:

- **`boolean` toggle**:
  - `true` (or omitted): Full inheritance from host defaults.
  - `false`: Completely disabled (passes `--no-mcp`, `--no-skills`, `--no-tools` respectively; `--no-mcp` physically shuts down the MCP subsystem so no server processes or network connections start).
  - MCP selection (`mcp: [server1]`) acts at the tool exposure and execution boundary via `--tools` / `--exclude-tools` patterns and child-bridge tool call gating. Non-whitelisted or excluded server tools cannot be viewed or called.
- **Exact list (Whitelist / Replace)**:
  - `[item1, item2]`: Activates only the named entries.
- **Incremental modifiers (`+` / `-`)**:
  - `["+itemA", "-itemB"]`: Adds or excludes entries relative to base defaults. Exact names and modifiers cannot be mixed.

### Built-in Agents

- **`scout`**: Read-only reconnaissance agent. Disabled by default until the user explicitly configures a model in `~/.pi/agent/agents/scout.md`.
- **`worker`**: General implementation agent. Configured with `model: inherit` to inherit the parent session's model and thinking level.
- **`reviewer`**: Code review agent. Configured with `model: inherit` and leverages skill discovery to run review skills.
