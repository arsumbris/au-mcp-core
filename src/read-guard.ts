// The read-before-write guard — a loadable MEDIATOR floor (plan 2608261532, Phase 5.1).
//
// Migrated from the au-mcp kernel literal. Behavior is UNCHANGED; the only difference is the
// source of its two per-session inputs, now the public SDK contract instead of daemon privilege:
//  - the read-time hash comes from `MediationContext.readHash(path)` (Phase-4 accessor), not a
//    daemon-injected `readView` map.
//  - the current on-disk hash comes from the always-granted read-only `MediationContext.broker`
//    (`content` read), not a closed-over `EngineBroker`.
// So this floor is a TRUE plugin: a user could rebuild it over the same handles (decision
// 2608261517). The kernel keeps MAINTAINING the read-view (write-seam freshness); only this deny
// POLICY lives here.
//
// SAFE-FLOOR mechanism (unchanged from the kernel): on an overwrite (`write_file`) of an EXISTING
// file, deny if the path was never read, or if its current engine hash differs from the read-time
// hash (changed since the session read it). A CREATE (target absent) is exempt — nothing to
// clobber, so no prior read is required (without this a net-new file deadlocks). `edit_file`
// self-guards through the channel (a stale `old_string` misses). An explicit `expected_hash` means
// the caller does its own CAS, so it passes.

import { existsSync } from 'node:fs'
import {
  EventKind,
  type PluginContext,
  type PluginRuntime,
  type PluginBroker,
  type PendingAction,
  type MediationContext,
  type Decision,
} from '@arsumbris/au-mcp-sdk'

/** Gate tool base-names that overwrite a whole file and so need a fresh-read check. */
const OVERWRITE_TOOLS = new Set(['write_file'])

/** Pull a string `file_path` out of a tool input, or null. */
function filePathOf(input: unknown): string | null {
  if (input && typeof input === 'object' && 'file_path' in input) {
    const p = (input as { file_path?: unknown }).file_path
    if (typeof p === 'string') return p
  }
  return null
}

/**
 * A path's CURRENT engine content hash via the read-only broker's `content` read, or null (no
 * engine / unreadable / error). The `content` read returns `{ content, hash }` from ONE coherent
 * disk read, and the hash is CATALOG-INDEPENDENT — present whenever the file is readable. The arg
 * is the ABSOLUTE path, taken as-is by the engine's `abs_arg` (no relativize). The kernel copy in
 * au-mcp (`currentContentHash`) stays there for the daemon's read-view enrichment; this is the
 * plugin-side twin over the SDK `PluginBroker`.
 */
async function currentContentHash(broker: PluginBroker | undefined, absPath: string): Promise<string | null> {
  if (!broker || !broker.available()) return null
  try {
    const frame = await broker.read('content', { path: absPath })
    if (frame.ready === false || frame.type === 'error') return null
    const result = frame.result as { hash?: unknown } | null
    return result && typeof result.hash === 'string' ? result.hash : null
  } catch {
    return null
  }
}

/**
 * Build the read-before-write decide function. `exists` is injectable for tests; production uses
 * `node:fs.existsSync` (ambient, in-process, free). Everything per-session comes from the
 * `MediationContext` handed at decide time.
 */
export function readBeforeWriteDecide(deps: { exists?: (path: string) => boolean } = {}) {
  const exists = deps.exists ?? existsSync

  const deny = (ctx: MediationContext, action: PendingAction, reason: string): Decision => {
    // Record the gate through the kernel bus (the trace observer persists it), like redirect.
    ctx.emit(EventKind.ToolDenied, { tool: action.tool, input: action.input, reason, belt: 'hook' })
    return { kind: 'deny', reason }
  }

  return async (action: PendingAction, ctx: MediationContext): Promise<Decision> => {
    const gatePrefix = ctx.launch.gatePrefix
    if (!gatePrefix || !action.tool.startsWith(gatePrefix)) return { kind: 'allow' }
    const base = action.tool.slice(gatePrefix.length)
    if (!OVERWRITE_TOOLS.has(base)) return { kind: 'allow' } // reads, edit_file (self-guards), etc.
    const path = filePathOf(action.input)
    if (!path) return { kind: 'allow' } // malformed; gate-side validation handles it
    // An explicit expected_hash means the caller is doing its own CAS — let it through.
    if (action.input && typeof action.input === 'object' && 'expected_hash' in action.input) return { kind: 'allow' }
    // A CREATE (target does not exist) has nothing to clobber, so it needs no prior read.
    if (!exists(path)) return { kind: 'allow' }
    const seen = ctx.readHash(path)
    if (seen === undefined) {
      return deny(ctx, action, `read ${path} through the gate before overwriting it (read-before-write)`)
    }
    const now = await currentContentHash(ctx.broker, path)
    if (now !== null && now !== seen) {
      return deny(ctx, action, `${path} changed on disk since you read it — re-read it before overwriting (read-before-write)`)
    }
    return { kind: 'allow' }
  }
}

/**
 * The loadable entry. The manifest (id `mcp.read-guard`, kind hook, shapes [mediator], tier floor,
 * critical) is derived by the daemon from the type-def's `plugin-runtime-meta`; this module exports
 * only the shape function, per the loadable contract. Construction needs no `ctx` — the guard reads
 * everything per-session from the `MediationContext` at decide.
 */
export function createPlugin(_ctx: PluginContext): PluginRuntime {
  return { decide: readBeforeWriteDecide() }
}
