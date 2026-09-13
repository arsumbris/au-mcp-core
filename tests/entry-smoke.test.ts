import { describe, it, expect } from 'vitest'
import type { PluginBroker, PluginContext } from '@arsumbris/au-mcp-sdk'

// `import.meta.glob` is a Vite/Vitest build-time macro (not in the tsc lib). Vite transforms only
// the LITERAL `import.meta.glob('pattern')` call, so it must be written inline; this augmentation
// only gives tsc the type. eager:false — each value is a lazy importer.
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

// Smoke test for the generated tool entries (Phase-3 review follow-up, plan 2608261532).
//
// Each `src/tool-*.ts` is a thin entry: `createPlugin(ctx) -> { invoke }`, where invoke comes
// from a factory called with the tool's HARDCODED id (e.g. `engineReadInvoke('mcp.au_anchors', …)`).
// The au-mcp-core unit tests exercise the factories directly, never these entries, so a wrong id
// string / swapped arg / bad createPlugin export in a generated entry would surface only at live
// serve. This closes that gap cheaply: import every entry, construct it, and confirm its id wired.
//
// A mis-wired id does NOT throw — the factory's `find(id)` misses and returns a fail-closure that
// answers `Error: unknown <kind> tool: <id>`. So we invoke and assert we did NOT hit that
// signature; a validation / engine-down error is fine (the id resolved, the real tool ran).
// NOTE: the def's `entry:` pointer (def -> this file) is NOT covered here — that binds at live
// discovery, which the plan's Phase-6 daemon verify checks.

const entries = import.meta.glob('../src/tool-*.ts')

// A broker that is "up" but answers nothing useful: a correctly-wired invoke runs its real logic
// and returns a validation / engine-down error, never the id-mismatch signature.
const broker: PluginBroker = { available: () => true, read: async () => ({}), mutate: async () => ({}) }
const ctx = { broker, workspace: '/tmp/au-mcp-core-smoke-ws' } as unknown as PluginContext

const ID_MISMATCH = /unknown (engine-read|file|intent) tool:/

// Guard against a host-relay invoke that blocks on a socket: race the invoke against a timer.
async function invokeSafely(invoke: (i: unknown) => Promise<{ content?: unknown }>): Promise<string> {
  const timeout = new Promise<{ content?: unknown }>((resolve) => setTimeout(() => resolve({ content: '__timeout__' }), 500))
  const r = await Promise.race([invoke({}).catch((e) => ({ content: `Error: ${String(e)}` })), timeout])
  return String(r.content)
}

describe('loadable tool entries: the generated createPlugin seam', () => {
  it('discovers every tool-*.ts entry', () => {
    expect(Object.keys(entries).length).toBeGreaterThanOrEqual(44)
  })

  for (const [file, load] of Object.entries(entries)) {
    it(`${file.replace('../src/', '')} constructs a wired runtime`, async () => {
      const mod = (await load()) as { createPlugin?: (c: PluginContext) => unknown }
      expect(typeof mod.createPlugin).toBe('function')
      const runtime = mod.createPlugin!(ctx) as {
        invoke?: (i: unknown) => Promise<{ content?: unknown }>
        decide?: unknown
        onEvent?: unknown
      }
      // Every entry must construct a valid PluginRuntime: a callable (invoke), or the one hook
      // the glob catches (tool-precondition, a mediator with decide). Its own logic is unit-tested.
      const hasShape = typeof runtime.invoke === 'function' || typeof runtime.decide === 'function' || typeof runtime.onEvent === 'function'
      expect(hasShape).toBe(true)
      // The id-resolution check applies to callables: a mis-wired id resolves to the fail-closure.
      if (typeof runtime.invoke === 'function') {
        const content = await invokeSafely(runtime.invoke)
        expect(content).not.toMatch(ID_MISMATCH)
      }
    })
  }
})
