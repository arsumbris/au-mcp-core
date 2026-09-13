// The tool-precondition guard — a loadable MEDIATOR floor (plan 2608261532, Phase 5.2).
//
// Gates a gate-tool call on the agent having READ the file(s) that tool declares as a
// read-precondition (`read-precondition-meta { onFiles: [[guide]] }` on the tool's own `mcp.tool`
// subtype). On a gate-tool call with a precondition, if any required path is NOT yet in the
// session read/served view, DENY with a pointer to read it first (decision 2607030037).
//
// Migrated from au-mcp-redirect. The behavior is unchanged; the two per-session inputs now come
// from the public SDK contract instead of daemon privilege (decision 2608261517):
//  - the read/served view: `MediationContext.hasRead(path)` (the Phase-4 accessor), not a
//    daemon-injected `hasRead` closure.
//  - the preconditions map: DERIVED here from the read-only broker (G2), not handed over from the
//    daemon `registry`. The floor enumerates `mcp.tool` subtypes, reads each
//    `read-precondition-meta.onFiles`, and resolves each wikilink via `resolve_target` — exactly
//    as an external user would. So a user could rebuild this floor with no privileged input.
//
// Generic: it never hardcodes a tool. Everything tool-specific arrives via the derived map.

import { basename, relative } from 'node:path'
import {
  EventKind,
  type PluginContext,
  type PluginRuntime,
  type PluginBroker,
  type PendingAction,
  type MediationContext,
  type Decision,
} from '@arsumbris/au-mcp-sdk'

const READ_PRECONDITION_META = 'read-precondition-meta'
const TOOL_BASE = 'mcp.tool'

// --- wire shapes (a minimal local mirror of au-mcp's discovery types) -------

interface WireMetaBlock {
  type_name: string
  body: { name: string; value: unknown }[]
}
interface WireSubtype {
  name: string
  repo?: string
  source?: { file?: string }
  meta_blocks?: WireMetaBlock[]
}

/** Match a meta block by its BASE type name, tolerant of a `::repo` import qualifier. */
const metaIs = (b: WireMetaBlock, base: string): boolean => b.type_name.split('::', 1)[0] === base

/** Flatten a meta block's `[{name, value}]` body into a record. */
function metaRecord(block: WireMetaBlock): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of block.body) out[field.name] = field.value
  return out
}

/** `mcp.tool.au_guide` -> `au_guide`: the BASE tool name (drops the `mcp.tool.` prefix). */
function baseNameOf(typeName: string): string {
  return typeName.slice(`${TOOL_BASE}.`.length)
}

/** Strip `[[ ]]` + any #anchor / ^block / ::repo fragment to the bare wikilink target name. */
function wikilinkTarget(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let s = raw.trim()
  if (s.startsWith('[[') && s.endsWith(']]')) s = s.slice(2, -2).trim()
  for (const frag of ['#', '^', '::']) {
    const i = s.indexOf(frag)
    if (i !== -1) s = s.slice(0, i)
  }
  return s.trim()
}

/**
 * Resolve each `onFiles` wikilink to an absolute path via the engine `resolve_target` read, with
 * the tool-def's own file as origin (so a bare target resolves against its repo). A bundle target
 * surfaces `source.file` (the physical path); a plain file surfaces `path`. Unresolvable entries
 * are skipped. Returns absolute paths (matching the read-view / served-view keys `hasRead` uses).
 */
async function resolveOnFiles(
  broker: PluginBroker,
  workspace: string,
  originFile: string,
  onFiles: unknown[],
): Promise<string[]> {
  const origin = relative(workspace, originFile)
  const out: string[] = []
  for (const raw of onFiles) {
    const target = wikilinkTarget(raw)
    if (!target) continue
    try {
      const frame = await broker.read('resolve_target', { target, origin })
      if (frame.ready === false || frame.type === 'error') continue
      const res = frame.result as { path?: unknown; source?: { file?: unknown } } | null
      const p = (typeof res?.source?.file === 'string' && res.source.file) || (typeof res?.path === 'string' && res.path)
      if (p) out.push(p)
    } catch {
      // skip an unresolvable target; a dangling onFiles is already an engine diagnostic
    }
  }
  return out
}

/**
 * Derive the base-tool -> required-abs-paths map from the read-only broker (G2). Enumerate the
 * `mcp.tool` subtypes, read each `read-precondition-meta.onFiles`, resolve each wikilink. Returns
 * `undefined` when NO engine is reachable (so the caller can retry rather than memoize an empty
 * map) — the kernel's own discovery builds this map once when the engine is up.
 */
export async function derivePreconditions(
  broker: PluginBroker | undefined,
  workspace: string,
): Promise<Map<string, string[]> | undefined> {
  if (!broker || !broker.available()) return undefined
  let frame
  try {
    frame = await broker.read('subtypes', { base: TOOL_BASE })
  } catch {
    return undefined
  }
  if (frame.ready === false || frame.type === 'error') return undefined
  const subtypes = (frame.result as { subtypes?: WireSubtype[] } | null)?.subtypes ?? []
  const map = new Map<string, string[]>()
  for (const def of subtypes) {
    const block = def.meta_blocks?.find((b) => metaIs(b, READ_PRECONDITION_META))
    if (!block || !def.source?.file) continue
    const onFiles = metaRecord(block).onFiles
    if (!Array.isArray(onFiles)) continue
    const resolved = await resolveOnFiles(broker, workspace, def.source.file, onFiles)
    if (resolved.length > 0) map.set(baseNameOf(def.name), resolved)
  }
  return map
}

/** The map derivation, injectable so tests supply a fixed map without a live engine. */
type Derive = (broker: PluginBroker | undefined, workspace: string) => Promise<Map<string, string[]> | undefined>

/**
 * Build the tool-precondition decide function. Captures the `workspace` (from PluginContext at
 * construction) and derives the preconditions map LAZILY on the first decide, using the decide-time
 * read-only broker — memoized once it succeeds (a failed derivation with no engine is retried, not
 * cached, so a startup race does not permanently disable the floor).
 */
export function toolPreconditionDecide(deps: { workspace: string; derive?: Derive }) {
  const derive = deps.derive ?? derivePreconditions
  let preconditions: Map<string, string[]> | undefined

  return async (action: PendingAction, ctx: MediationContext): Promise<Decision> => {
    const gatePrefix = ctx.launch.gatePrefix
    if (!gatePrefix || !action.tool.startsWith(gatePrefix)) return { kind: 'allow' }
    const base = action.tool.slice(gatePrefix.length)
    if (!preconditions) {
      const derived = await derive(ctx.broker, deps.workspace)
      if (!derived) return { kind: 'allow' } // no engine yet — can't derive; allow (kernel parity)
      preconditions = derived
    }
    const required = preconditions.get(base)
    if (!required || required.length === 0) return { kind: 'allow' } // no precondition on this tool
    const missing = required.filter((p) => !ctx.hasRead(p))
    if (missing.length === 0) return { kind: 'allow' }
    // Point at the file(s) by basename (readable); reading any of them (via the gate read or the
    // serving tool) registers it and satisfies the gate.
    const names = missing.map((p) => basename(p)).join(', ')
    const reason = `read ${names} before ${base} — this tool requires it. Read it through the gate (read_file_pinned) or the tool that serves it first.`
    ctx.emit(EventKind.ToolDenied, { tool: action.tool, input: action.input, reason, belt: 'hook' })
    return { kind: 'deny', reason }
  }
}

/**
 * The loadable entry. Manifest (id `mcp.tool-precondition`, kind hook, shapes [mediator],
 * tier floor, critical) is derived from the type-def's `plugin-runtime-meta`; this module exports
 * only the shape function. The workspace is captured from PluginContext for the map derivation.
 */
export function createPlugin(ctx: PluginContext): PluginRuntime {
  return { decide: toolPreconditionDecide({ workspace: ctx.workspace }) }
}
