// Loadable entry for au_diagnostics (a callable). One createPlugin per tool: the daemon
// derives the manifest from the `mcp.tool.au_diagnostics` def and imports this entry for the
// runtime (createPlugin -> { invoke }), the same shape au-provenance's tools take.
//
// De-privileged from au-mcp's engine.ts literal — this is the shipped path a user's own tool
// takes too (decision 2608261517: the kernel holds only the mechanism; tools are true plugins
// over PluginContext). It reaches the engine solely through `ctx.broker`, no in-process privilege.

import type { PluginContext, PluginRuntime, PluginBroker, CallableResult } from '@arsumbris/au-mcp-sdk'
import { ok, fail, optNumber, optString, engineDown } from './result.ts'

// au_diagnostics paging bounds (the agent-context-budget clamp is ours; the def carries limit/offset).
// A 0/negative/non-finite limit falls to the default; the page is capped at the max.
const DEFAULT_DIAG_LIMIT = 50
const MAX_DIAG_LIMIT = 500
const clampLimit = (n?: number): number =>
  n === undefined || !Number.isFinite(n) || n < 1 ? DEFAULT_DIAG_LIMIT : Math.min(MAX_DIAG_LIMIT, Math.floor(n))
const clampOffset = (n?: number): number =>
  n === undefined || !Number.isFinite(n) ? 0 : Math.max(0, Math.floor(n))

// The present (defined) keys of input, passed through as engine-read filters.
const present = (input: unknown, ...keys: string[]): Record<string, unknown> => {
  const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  for (const k of keys) if (r[k] !== undefined) out[k] = r[k]
  return out
}

// diagnostics: full-scope { total, by_severity, by_code } summary + an errors-first page.
// Two engine reads: `diagnostic_counts` (the summary, no entries materialized) + `diagnostics`
// (the paged entries). ERRORS-FIRST is ours: with no severity filter the page defaults to
// errors (the actionable set) while the summary still spans every severity.
function auDiagnosticsInvoke(broker: PluginBroker | undefined) {
  return async (input: unknown): Promise<CallableResult> => {
    if (!broker || !broker.available()) return fail(engineDown(new Error('no engine reachable')))
    const filters = present(input, 'path', 'path_prefix', 'severity', 'code')
    const limit = clampLimit(optNumber(input, 'limit'))
    const offset = clampOffset(optNumber(input, 'offset'))
    const pageSeverity = optString(input, 'severity') ?? 'error'
    try {
      const countsFrame = await broker.read('diagnostic_counts', filters)
      if (countsFrame.ready === false) return fail('engine not ready (ref still deriving)')
      if (countsFrame.type === 'error') return fail(JSON.stringify(countsFrame, null, 2))
      const pageFrame = await broker.read('diagnostics', { ...filters, severity: pageSeverity, limit, offset })
      if (pageFrame.ready === false) return fail('engine not ready (ref still deriving)')
      if (pageFrame.type === 'error') return fail(JSON.stringify(pageFrame, null, 2))
      const page = Array.isArray(pageFrame.result) ? pageFrame.result : []
      const truncated = page.length === limit // a short page (< limit) means done
      return ok({
        summary: countsFrame.result ?? { total: 0, by_severity: {}, by_code: {} },
        severity: pageSeverity, // the severity the returned entries belong to
        diagnostics: page,
        offset,
        limit,
        truncated,
        ...(truncated ? { next_offset: offset + limit } : {}),
      })
    } catch (e) {
      return fail(engineDown(e))
    }
  }
}

export function createPlugin(ctx: PluginContext): PluginRuntime {
  return { invoke: auDiagnosticsInvoke(ctx.broker) }
}
