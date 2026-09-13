import { describe, it, expect } from 'vitest'
import { createPlugin } from '../src/instance-count-notice.ts'
import type { PluginContext, PluginBroker, SessionStartContext, EngineFrame } from '@arsumbris/au-mcp-sdk'

// The instance-count-notice session-start hook (decision 2609020302). It receives ONE instance's
// typed config from the daemon (per-instance, decision 2609021429 — no more `{ checks: [] }` blob),
// counts instances_of the configured type over a read-only broker, and injects a notice when the
// count exceeds the threshold. `forType` rides as a `type*` def-ref wikilink the hook reduces to the
// bare name. These tests drive onSessionStart(ctx, config) over a fake broker.

function fakeBroker(counts: Record<string, number>, opts: { available?: boolean } = {}): PluginBroker {
  return {
    available: () => opts.available ?? true,
    read: async (op: string, args?: Record<string, unknown>): Promise<EngineFrame> => {
      if (op !== 'instances_of') return { result: [] }
      const type = String((args as { type?: unknown })?.type)
      const n = counts[type]
      if (n === undefined) return { type: 'error', result: null } // unknown type -> engine error
      return { result: Array.from({ length: n }, (_, i) => ({ path: `${type}-${i}.md` })) }
    },
    mutate: async () => ({}),
  }
}

function ctxWith(broker?: PluginBroker): SessionStartContext {
  return {
    session: 's1',
    run: 1,
    isResume: false,
    launch: {},
    consultTrace: async () => ({ events: [], headSeq: 0 }),
    broker,
    emit: () => {},
    scope: { tools: { active: [], mounted: [] }, skills: { active: [], mounted: [] }, members: [] },
  } as SessionStartContext
}

const hook = createPlugin({ workspace: '/ws' } as PluginContext)

describe('instance-count-notice session-start hook', () => {
  it('is inert when unconfigured (no config instance for it)', async () => {
    expect(await hook.onSessionStart!(ctxWith(fakeBroker({})), undefined)).toBeUndefined()
  })

  it('injects when the count exceeds the threshold (forType as a def-ref wikilink)', async () => {
    const r = await hook.onSessionStart!(ctxWith(fakeBroker({ task: 5 })), { forType: '[[task]]', threshold: 3 })
    expect(r).toEqual({ inject: ["⚠ 5 instances of type 'task' (over threshold 3)."] })
  })

  it('accepts a bare (unwrapped) forType too', async () => {
    const r = await hook.onSessionStart!(ctxWith(fakeBroker({ task: 5 })), { forType: 'task', threshold: 3 })
    expect(r).toEqual({ inject: ["⚠ 5 instances of type 'task' (over threshold 3)."] })
  })

  it('reduces a ::repo-qualified def-ref to the bare type name for instances_of', async () => {
    const r = await hook.onSessionStart!(ctxWith(fakeBroker({ task: 5 })), { forType: '[[task::au-mcp-core]]', threshold: 3 })
    expect(r).toEqual({ inject: ["⚠ 5 instances of type 'task' (over threshold 3)."] })
  })

  it('injects nothing when the count is at or below the threshold', async () => {
    expect(await hook.onSessionStart!(ctxWith(fakeBroker({ task: 5 })), { forType: '[[task]]', threshold: 5 })).toBeUndefined()
  })

  it('expands placeholders in a custom message', async () => {
    const r = await hook.onSessionStart!(
      ctxWith(fakeBroker({ task: 4 })),
      { forType: '[[task]]', threshold: 1, message: '{count} {type} over {threshold}' },
    )
    expect(r).toEqual({ inject: ['4 task over 1'] })
  })

  it('skips on an unknown type or a down engine, never throwing', async () => {
    // unknown type -> engine 'error' -> no inject
    expect(await hook.onSessionStart!(ctxWith(fakeBroker({})), { forType: '[[ghost]]', threshold: 0 })).toBeUndefined()
    // engine unavailable -> no-op
    expect(
      await hook.onSessionStart!(ctxWith(fakeBroker({ task: 1 }, { available: false })), { forType: '[[task]]', threshold: 0 }),
    ).toBeUndefined()
  })

  it('is inert on a malformed config (missing required fields)', async () => {
    expect(await hook.onSessionStart!(ctxWith(fakeBroker({ task: 5 })), { threshold: 3 })).toBeUndefined()
    expect(await hook.onSessionStart!(ctxWith(fakeBroker({ task: 5 })), { forType: '[[task]]' })).toBeUndefined()
  })
})
