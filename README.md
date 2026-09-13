---
type: au.engine.readme::au-engine
tldr: The bundled baseline plugin package for the au-mcp kernel — the default agent surface, the governance floors, and the first-party session-start hooks. Mount it as a workspace member and the kernel discovers and loads its plugins. Extend it by building your own tools and hooks against au-mcp-sdk in your own repo.
---

# Repo Overview

## General Context
Before defining what `au-mcp-core` is,
here is some general context of the environment it exists in.

- `arsumbris` is a framework for agentic knowledge work.
- `au-engine` serves a graph over a cross-repo substrate of typed files.
- `au-host` is the UI part of the framework.
- `au-mcp` is the agent layer of the framework — a workspace-scoped daemon that serves agent sessions.
  - the kernel holds only the MECHANISM: it discovers plugins, orchestrates them in phases, brokers engine access, and serves clients over the wire.
  - it ships ZERO tools of its own. Every agent-facing capability and every policy is a PLUGIN.
- `au-mcp-sdk` is the contract every plugin, adapter, and the kernel speak.

`au-mcp-core` is part of this `arsumbris` framework.
It is the baseline set of plugins the kernel serves.


## What this is

`au-mcp-core` is the **bundled baseline plugin package** for the `au-mcp` kernel.
- it ships the default agent surface
  - file ops
  - engine reads
  - intents
- plus the always-present governance floors
  - the native-tool redirect (tier `gate`)
  - read-guard, tool-precondition (tier `floor`)
- plus first-party session-start hooks
  - instance-count-notice (inject a notice when a configured type has more than N instances)
  - repo-overview (inject a per-repo overview built from each mounted README's tldr)
  - requiredScope-check (warn when a tool/hook's declared `requires` is not mounted or not active)
- all built against `@arsumbris/au-mcp-sdk`.

The kernel holds only the mechanism.
Tools and policy are plugins.
- `au-mcp-core` is "core" only in that a workspace mounts it to get the default surface.
- structurally it is a plugin package like any other. Nothing here is privileged.
- the invariant:
  - every capability a core plugin uses is reachable from the SDK's `PluginContext` / `MediationContext`
  - A user could rebuild any of them.

### What it ships

**Callable tools** (the agent-facing surface):
- **file ops**
  - `read_file`, `write_file`, `edit_file`, `delete_file`, `glob`, `grep`.
- **shell**
  - `bash`.
- **engine mutations**:
  - `assign_block_id`, `rename`, `rename_type`, `promote`, `inline`, `rename_block_id`.
- **engine reads** (`au_*`)
  - the typed-graph read surface: instances, types, references, diagnostics, frontmatter, and more.
- **intents**
  - `au_host_intent_fire`, `au_host_intent_list`, `au_host_pane_op`, `au_host_snapshot`.
  - the agent-facing edge of the host-relay surface.

**Governance floors** (kernel-internal hooks, the agent never calls them). Each declares an ordering `tier` (`gate | floor | policy`, earlier decides first) instead of a raw priority number:
- **native-tool redirect** (`mcp.nativeToolRedirect`, tier `gate`)
  - a mediator: enforce the session's native-tool allowlist, pointing a denied native tool at its gate equivalent.
  - `gate` decides first (outermost): a denied native short-circuits before the safety floors run.
  - driven by the `nativeToolAllowlist` field on the session's `agent-profile`
    - (tri-state: absent = all allowed, `[]` = none, `[names]` = only those).
- **read-guard** (`mcp.read-guard`, tier `floor`)
  - a mediator: deny a write that would overwrite a file the session has not read, or read stale.
- **tool-precondition** (`mcp.tool-precondition`, tier `floor`)
  - a mediator: gate a tool until its declared `read-precondition` files have been read.
  - it DERIVES its own precondition map from the engine, exactly as an external plugin would.

**Session-start hooks** (kernel-internal, run once at session-open):
- **instance-count-notice** (`mcp.instance-count-notice`, tier `policy`)
  - a session-start hook: count instances of a configured type at open, inject a notice when the count exceeds its threshold.
  - config is TYPED, not a JSON blob (decision 2609021429): the def's fields (`forType` def-ref, `threshold`, `message?`) ARE the config. An agent-profile's `hookConfig` carries one instance per check; the daemon runs the hook once per instance with its typed fields. The config TS type is GENERATED from the def (`npm run gen:types` → `src/generated.ts`), never hand-written.
  - INERT until configured — no `hookConfig` instance, no inject.
  - the first-party demo of the session-start shape — "if there are more than N instances of type T, inject some context".
- **repo-overview** (`mcp.repo-overview`, tier `policy`)
  - a session-start hook: at open, inject a REPOSITORY OVERVIEW — one block per mounted workspace member, each a repo link + the repo's README `tldr` + a link to its full README.
  - CONFIG-LESS + always-on: no `hookConfig`, so the daemon runs it once with `config` undefined. It injects whenever an agent-profile's `hooks` whitelist does not exclude it.
  - reads two engine reads over the read-only broker: `members` (the mounted-repo spine) joined by member name onto `instances_of(au.engine.readme)` (each README's `tldr`). Falls back to the repo name when a README or its tldr is absent.
  - recomputed per session against live graph state (the mounted set + each tldr), unlike a static `mcp.inject`.
- **requiredScope-check** (`mcp.requiredScope-check`, tier `policy`)
  - a session-start hook: walk every mounted `mcp.tool` / `mcp.hook` def that declares `required-scope-meta`, and per required ref consult the kernel-resolved `ctx.scope` (decision 2609071712).
  - injects one line per ref that is NOT MOUNTED (absent from every scope set) or MOUNTED BUT NOT ACTIVE (in a `mounted` set, excluded by the profile's tool/skill allowlist). Turns a silent late failure into a legible notice at open.
  - CONFIG-LESS + always-on, best-effort. Reads `subtypes` over the broker; consults `ctx.scope`, so it re-derives no allowlist.
  - v1 covers TOOLS + HOOKS; skills are instances of `mcp.skill`, so a per-skill type-meta does not apply (a skill `requires` field is a follow-up).

The floors are marked `critical`.
- `critical` is a general manifest flag ANY plugin may set (it lives on `BaseManifest`, so tools and hooks alike).
- it means fail-closed-at-load: if a `critical` plugin fails to load, the daemon refuses to serve rather than run without it.
- it matters most for the floors — a session must never run ungoverned because a gate quietly failed to load.

## How to use this

`au-mcp-core` is not run directly.
It is **mounted as a workspace member**,
and the kernel discovers and loads it like any plugin package.

- each tool / floor is an engine type-def (`mcp.tool.*` / `mcp.hook.*`) carrying a `plugin-runtime-meta` entry.
- the kernel reads those subtypes over its engine broker, imports each entry's `createPlugin`, and registers the result.
- so mounting `au-mcp-core` in a workspace IS how a session gets the default surface. Nothing is compiled into the kernel.

Consumed as **TypeScript source** — there is no build step.
- Node runs the `.ts` directly (type-stripping); nothing is compiled to `.js`.
- the kernel `import()`s each def's entry `.ts` file at discovery, and the `link:`-ed dependencies resolve to source, not built artifacts.
- the family convention: `type: module`, run source, `tsc --noEmit` to typecheck, `vitest` to test.

Depends on:
- `@arsumbris/au-mcp-sdk` — the plugin contract (the only dependency that matters).
- `@arsumbris/au-engine-sdk` — for one pure wikilink-parsing util, not engine access.


## How to extend this

Build your own tools and hooks against `@arsumbris/au-mcp-sdk`, in your own repo.
See the SDK's "How to extend this" for the full tool / hook authoring flow.
- or invoke the `/au-mcp-sdk:build-a-plugin` skill, which walks an agent through it step by step.
