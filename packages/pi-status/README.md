# @hheei/pi-status

High-density response telemetry and compact two-line footer extension for Pi. Compatible with Pi `>=0.99.0` and `1.0.0`.

```bash
pi install npm:@hheei/pi-status
```

The package mounts an ext-core response status tracker and replaces Pi's default TUI footer with an informative, compact two-line layout.

## Features

- **Compact Two-Line Footer**: Maximizes vertical editor space while presenting critical session context at a glance.
- **Top Row (Session & Worktree)**:
  - Current working directory with `~` home abbreviation and path fitting.
  - Active Git branch name and dirty status indicators (`*`).
  - Active session stats and timing.
- **Bottom Row (Model & Telemetry)**:
  - Full model identifier with provider prefix (e.g. `anthropic/claude-3.5-sonnet`, `cx/gpt-6.1-sol`).
  - Thinking level indicator when active (e.g. `(high)`, `(low)`).
  - Routing indicator when a virtual model resolves to a distinct physical model (`virtual -> physical`).
  - Context window visualization gauge with percentage and token counts (e.g. `[████░░░░░░] 42% (84k/200k)`), colored dynamically as limits approach.
  - Session token usage and cumulative cost tracking.
  - Right-aligned running child agents count followed by the TODO status, separated by ` ‧ ` (e.g. `agents x3 ‧ 󰪠 #1 Task`); the separator is dropped when only one side is present, and an unrelated extension status is shown only when both are absent.
- **Lifecycle Cleanliness**: Gracefully unmounts and restores original UI footers on session disposal or reload.

## Installation

Add to your Pi configuration or install directly via npm:

```bash
pi install npm:@hheei/pi-status
```

The extension entrypoint is declared under `dist/extension.js` and automatically activates in TUI mode.
