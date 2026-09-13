// Callable-result + input-access helpers, shared by au-mcp-core's plugin entries.
//
// A callable returns the SDK's `CallableResult` ({ content, isError? }). `content` is the
// payload; the MCP-server shim (in the adapter) formats it into MCP content.
//
// Ported verbatim from au-mcp's src/plugins/result.ts as the tools move out of the kernel
// into true plugins (decision 2608261517). Kept core-local for now; a later call may hoist
// these generic helpers into au-mcp-sdk so every plugin (core, first-party, user) shares one.

import type { CallableResult } from '@arsumbris/au-mcp-sdk'

export const ok = (content: unknown): CallableResult => ({ content })
export const fail = (message: string): CallableResult => ({ content: `Error: ${message}`, isError: true })

/**
 * The engine-unreachable hint every read appends when the broker cannot be reached.
 * "repo" is the ENTRY sense: the daemon is started on ONE folder-repo directory.
 */
export const ENGINE_DOWN_HINT = 'Is the daemon running on the repo? (the human starts it)'
/** `<what the broker threw>. <the hint>` — the shape an engine read's catch block returns. */
export const engineDown = (e: unknown): string => `${(e as Error).message}. ${ENGINE_DOWN_HINT}`

// --- input access ----------------------------------------------------------
// Tool input arrives as `unknown` over the wire; it is SHAPE-VALIDATED before a plugin runs
// (the daemon validates against `mcp.tool.<tool>` via the engine). These are the plugin's
// defensive reads of the validated input, not a second validator layer.

const rec = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' ? (input as Record<string, unknown>) : {}

export const optString = (input: unknown, key: string): string | undefined => {
  const v = rec(input)[key]
  return typeof v === 'string' ? v : undefined
}
export const optNumber = (input: unknown, key: string): number | undefined => {
  const v = rec(input)[key]
  return typeof v === 'number' ? v : undefined
}
export const optBool = (input: unknown, key: string): boolean | undefined => {
  const v = rec(input)[key]
  return typeof v === 'boolean' ? v : undefined
}
export const optObject = (input: unknown, key: string): Record<string, unknown> | undefined => {
  const v = rec(input)[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}
