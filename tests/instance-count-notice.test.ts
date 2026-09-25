import { describe, it, expect } from 'vitest'
import { createPlugin } from '../src/instance-count-notice.ts'
import type { PluginContext, PluginBroker, SessionStartContext, EngineFrame } from '@arsumbris/au-mcp-sdk'

// The instance-count-notice session-start hook (decision 2609020302). It receives ONE instance's
// typed config from the daemon (per-instance, decision 2609021429 — no more `{ checks: [] }` blob),
// reads `instance_counts` (the cheap count-dual of instances_of, not the row list) over a read-only
// broker, sums the `by_type` rows matching the configured type, and injects a notice when the count
// exceeds the threshold. `forType` rides as a `type*` def-ref wikilink the hook reduces to the bare
// name. These tests drive onSessionStart(ctx, config) over a fake broker.

// A fake `instance_counts` read: `counts` maps a bare type name to its instance count, projected onto
// the identity-keyed `by_type` view. An absent type is simply not in `by_type` (count 0), the way the
// engine returns it — there is no per-type "unknown type" error on this read.
function fakeBroker(counts: Record<string, number>, opts: { available?: boolean } = {}): PluginBroker {
  return {
    available: () => opts.available ?? true,
    read: async (op: string): Promise<EngineFrame> => {
      if (op !== 'instance_counts') return { result: null }
      const by_type = Object.entries(counts).map(([name, count], i) => ({
        name,
        hash: `h${i}`,
        type_owners: ['au-mcp-core'],
        count,
      }))
      return { result: { aborted_at_load: false, total: by_type.reduce((s, r) => s + r.count, 0), by_type } }
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

  it('reduces a ::repo-qualified def-ref to the bare type name matched against the counts table', async () => {
    const r = await hook.onSessionStart!(ctxWith(fakeBroker({ task: 5 })), { forType: '[[task::au-mcp-core]]', threshold: 3 })
    expect(r).toEqual({ inject: ["⚠ 5 instances of type 'task' (over threshold 3)."] })
  })

  it('sums the counts of every identity sharing the bare type name', async () => {
    // Two cross-repo identities of `task` -> two by_type rows; the bare count is their sum (7).
    const broker: PluginBroker = {
      available: () => true,
      read: async (op: string): Promise<EngineFrame> =>
        op === 'instance_counts'
          ? {
              result: {
                aborted_at_load: false,
                total: 7,
                by_type: [
                  { name: 'task', hash: 'a', type_owners: ['au-mcp-core'], count: 5 },
                  { name: 'task', hash: 'b', type_owners: ['other'], count: 2 },
                  { name: 'plan', hash: 'c', type_owners: ['au-mcp-core'], count: 9 },
                ],
              },
            }
          : { result: null },
      mutate: async () => ({}),
    }
    const r = await hook.onSessionStart!(ctxWith(broker), { forType: '[[task]]', threshold: 3 })
    expect(r).toEqual({ inject: ["⚠ 7 instances of type 'task' (over threshold 3)."] })
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

  it('skips on an absent type or a down engine, never throwing', async () => {
    // absent type -> no by_type row -> count 0 -> no inject (0 > 0 is false)
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
