# Extension Development Guide

This guide is the workflow for building independent Pi extensions. The target
layout is specified in [Extension Reference Architecture](../architecture/extension-reference.md).

## Package Direction

New functionality belongs in its own extension package:

```text
packages/
  pi-ext-core/
  pi-<name>/
```

All installable packages are independent extensions. A `pi-<name>` package may own one feature or a
cohesive family of related features; split it only when installation, lifecycle,
or public API ownership differs. An extension may depend on `pi-ext-core` and
upstream Pi packages, but never on another concrete extension.

## Feature Workflow

For substantial feature, architecture, persistence, lifecycle, public-contract, or UI/UX work:

1. Inspect existing repository implementations and the relevant Pi API.
2. Write or update the matching high-level `docs/<topic>/` document in Simplified Chinese. Describe the user-facing intent, module boundary, and public interface.
3. Use `grill-me` to resolve the design with the user. Use `grill-with-docs` when the decision also needs ADRs or a shared glossary. Obtain explicit agreement.
4. Build the smallest runnable end-to-end path and define only the public contract it needs.
5. Add focused tests for uncovered observable behavior and implement the remaining details.
6. Run focused verification, including the actual Pi surface when UI behavior changes.

Small fixes and local refactors may skip new design documents: inspect callers, make the smallest sound change, and verify affected behavior. For UI or UX work, follow [DESIGN.md](../../DESIGN.md) and reuse `@hheei/pi-ext-core` UI primitives where appropriate.

## Focused Verification

Install dependencies:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Run checks only for the affected code:

```bash
pnpm exec vitest run <focused-test-path>
pnpm exec biome check <changed paths...>
```

Apply formatting or safe lint fixes only to changed paths:

```bash
pnpm exec biome check --write <changed paths...>
```

For shared-interface, dependency, or cross-package changes, also run the root
`pnpm run typecheck` and `pnpm test`. Release validation follows the repository
release gate in [AGENTS.md](../../AGENTS.md).

## Extension Entry Point

Pi loads the package entry declared by `pi.extensions`. Keep `src/extension.ts`
as the composition root: register surfaces, create session-scoped feature state,
and delegate behavior to internal modules. See the reference architecture for
the package layout and public API boundary.

A minimal extension looks like this:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI) {
	pi.registerCommand("pi-my-extension", {
		description: "Run my extension command",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Loaded", "info");
		},
	});
}
```

## Local Testing in Pi

Run from the repository root. Build ext-core before a dependent extension with a
`dist/` entry; use the selected package's manifest for its actual build script and entry:

```bash
pnpm --filter @hheei/pi-ext-core run build
pnpm --filter @hheei/pi-<name> run build
pi --no-extensions --no-skills -e packages/pi-<name>/dist/extension.js
```

Source-entry packages do not need a TypeScript build unless their manifest
declares one.
Additional Pi arguments can be appended to the command above.

For the fixed repository development combination with incremental builds, see
[Local Pi development](pi-dev.md).

## Release Preparation

Public workspaces version independently: each `packages/pi-<name>/package.json` owns its own
`version`, and a release publishes only the packages whose version is not yet on npm, so
packages that did not change keep their version and are skipped. Private workspaces are
excluded from publication. A released version is immutable, so bump a package's own version
whenever its content changes. There is no repository-wide release version; the root
manifest's `version` is the private root package's own version and is not a release
coordinate.

Run the release checks from the repository root before requesting approval:

```bash
pnpm run build
pnpm run validate:packages
pnpm run publish:dry-run
```

The build step compiles packages with generated `dist/` artifacts; source-entry packages
are validated from their declared files. The artifact-validation step then verifies every
publishable package, and the final command inventories each npm tarball and simulates
publication. Validation reads the actual tarball manifest and rejects unresolved
`workspace:`, `link:` and `file:` dependency ranges and bundled host runtime dependencies.
The publisher uses `pnpm pack` to resolve workspace ranges, validates the resulting archive,
then passes that same archive to `npm publish`; never publish a workspace source directory
with `npm publish`. Host-provided `typebox` belongs in `peerDependencies` with a `"*"` range,
not runtime dependencies. These checks also apply to ext-core and other shared packages.

Host packages (`@earendil-works/pi-coding-agent`, `pi-tui`, `pi-agent-core`, `pi-ai`) belong in
`peerDependencies` with the lowest host version that compiles the package's `src/`, not with the
version currently installed. Raising a floor is required only when a package starts using a newer
host API. Every package now declares `>=1.5.0`: Pi 1.5 runs tool argument validation on
`pi-schema`, requires `keyText`/`keyHint` on render contexts, adds `ExecResult.truncated`, and
exposes `ResolvedPaths.installFailures`, so an older host no longer compiles against these
packages. Workspace `devDependencies` track `^1.5.0` instead of a fixed host version, so
`pnpm run pi-dev` runs the newest 1.x host; nothing in the repository pins or rewrites either side
automatically.
A real tag or publish still requires explicit approval for that exact version and action.

Release CI uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
through GitHub Actions OIDC, not a long-lived token secret. The publish job explicitly
installs npm 11.21.0: OIDC publishing requires npm CLI >=11.5.1 and Node >=22.14.0;
the npm bundled with Node 22.19.0 is too old. Keep `id-token: write` enabled.
Each public package's npm Trusted Publisher must match `hheei`, `pi-mono`, and
`release.yml` (filename only), permit direct `npm publish`, and omit an environment
restriction unless the publish job declares the same GitHub environment.

## Package Checklist

Before considering an extension ready:

- the feature belongs to the smallest cohesive `pi-<name>` package
- shared mechanisms use `@hheei/pi-ext-core`; concrete extensions do not import each other
- command names are stable and start with `pi-` where practical
- session-scoped resources have an explicit owner, cancellation path, and idempotent cleanup
- package README records installation or compatibility changes
- focused tests cover the affected behavior

