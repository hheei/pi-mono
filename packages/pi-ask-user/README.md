# @hheei/pi-ask-user

Interactive `ask_user` tool for pi: one focused question, or 2-4 independent questions in one prompt, with multiple choice, multi-select, and freeform answers.

Forked from [`edlsh/pi-ask-user`](https://github.com/edlsh/pi-ask-user) at revision `df1df70` (v0.17.1). Upstream is MIT licensed; see [LICENSE](./LICENSE).

## What the fork changes

- Ships compiled `dist/` through `tsc` instead of raw TypeScript, matching the other `@hheei/pi-*` packages.
- Uses the `typebox` package instead of `@sinclair/typebox`.
- Tests run on vitest instead of `bun test`.
- Code conforms to this repo's Biome and `exactOptionalPropertyTypes` rules.
- Reads preferences through `@hheei/pi-ext-core` from the `askUser` section of `ext_settings.json`, so project `.pi/ext_settings.json` can override the global file. Upstream's own `ask-user.json` and the `PI_ASK_USER_*` environment layer are gone.
- Drops upstream's searchable split-pane list, optional comment stage, overlay hide shortcut, review-page scrolling, and `ctrl+j`/`ctrl+k` vim aliases: the prompt now matches pi's own select-list keys.
- Drops the upstream `pi-tern` native-presentation integration. Prompts render through pi's own TUI components, and results publish presentation facts that `@hheei/pi-ext-ui` frames with its 0/1/2 fold levels when it is installed.
- Registers an `ask_user` settings page through `@hheei/pi-ext-core`, so the preferences below are editable in the host settings UI instead of by hand.

Module boundaries, invariants, and the test layout are recorded in
[`docs/architecture/ask-user.md`](../../docs/architecture/ask-user.md).

The batch contract is unchanged: `context`, `options`, `allowMultiple`, and `allowFreeform` belong on each `questions` entry, never at the top level. Top-level copies are ignored rather than rejected, because strict providers fill every declared property with an empty default. A one-entry `questions` array is unwrapped and asked as a single question instead of failing.

## Install

```bash
pi install npm:@hheei/pi-ask-user
```

## Tool

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `question` | `string?` | — | The question. With `questions`, it is only the batch heading |
| `questions` | `{question, context?, options?, allowMultiple?, allowFreeform?}[]?` | — | 2-4 independent questions, used instead of `question` |
| `context` | `string?` | — | Summary shown above the question |
| `options` | `{title, description?}[]?` | — | Choices offered to the user |
| `allowMultiple` | `boolean?` | `false` | Allow selecting several options |
| `allowFreeform` | `boolean?` | `true` | Add a freeform answer row |
| `displayMode` | `"overlay" \| "inline"` | `overlay` | Centered modal or in-place prompt |
| `timeout_ms` | `integer?` | — | Auto-dismiss after N milliseconds; the result is cancelled |

## Keys

| Context | Keys |
| --- | --- |
| List | `↑`/`↓`, `tab`/`shift+tab`, `1`-`9` jump or toggle |
| Single select | `enter` choose (on the freeform row: open the editor) |
| Multi select | `space` tick, `enter` submit |
| Editor | `enter` submit, `shift+enter`/`ctrl+j` newline, `esc` back or cancel |
| Prompt | `ctrl+e` expand context, `PgUp`/`PgDn`/`Home`/`End` scroll (overlay) |
| Batch | `tab`/`shift+tab` pages, `1`-`N` jump from review, `enter` submit, `esc` cancel |
| Anywhere | `esc`/`ctrl+c` cancel |

## Preferences

One setting, editable from the host settings UI or by hand: `displayMode` in the `askUser` section of `<agent-dir>/ext_settings.json` (project `.pi/ext_settings.json` wins), read on every call. A call parameter overrides it.

`ask:answered` and `ask:cancelled` events carry only the question and the response kind; context and the actual answer stay in the tool result.

## Skill

The package bundles the `ask-user` skill, which turns `ask_user` into a gate before high-stakes or ambiguous decisions. It is installed with the package; remove `skills/` from your package list if you only want the tool.

## Development

```bash
pnpm --filter @hheei/pi-ask-user run build
pnpm exec vitest run packages/pi-ask-user/test
```
