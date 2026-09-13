// Path-guard floor, ported from old au-mcp `src/lib/guard.ts`.
//
// write/edit refuse two roots regardless of any mode:
// - any path with a `.claude` segment (the redirect config must not be
//   writable through a gate tool),
// - paths under `<workspace>/operations/` (the trace must not be writable).
// bash is an honest hole and is not guarded (capture-first).

import { resolve, sep } from 'node:path'

/** Returns a refusal reason, or null if the write path is allowed. */
export function guardWritePath(workspace: string, filePath: string): string | null {
  const resolved = resolve(filePath)
  if (resolved.split(sep).includes('.claude')) {
    return 'path guard: writes under .claude/ are refused, the redirect config is not writable through a gate tool'
  }
  const operationsRoot = resolve(workspace, 'operations')
  if (resolved === operationsRoot || resolved.startsWith(operationsRoot + sep)) {
    return 'path guard: writes under operations/ are refused, the trace is not writable through a gate tool'
  }
  return null
}
