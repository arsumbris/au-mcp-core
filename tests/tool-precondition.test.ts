import { describe, it, expect } from 'vitest'
import { toolPreconditionDecide, derivePreconditions } from '../src/tool-precondition.ts'
import type { MediationContext, PluginBroker, Decision } from '@arsumbris/au-mcp-sdk'

// The tool-precondition floor as a loadable plugin (plan 2608261532, Phase 5.2). Migrated from
// au-mcp-redirect. It reads the session read/served view from ctx.hasRead (Phase-4 accessor) and
// DERIVES its own preconditions map from the broker (G2) — so these tests drive the decide with an
// injected `derive` (a fixed map) over a mock MediationContext, and separately exercise the real
// `derivePreconditions` against a mock broker.

const GATE = 'mcp__au__'
const GUIDE = '/pkg/guides/schema-induction.md'
const denyReason = (d: Decision) => (d.kind === 'deny' ? d.reason : '')

function fakeCtx(read: Set<string>): MediationContext & { emitted: { kind: string; data: unknown }[] } {
  const emitted: { kind: string; data: unknown }[] = []
  return {
    emitted,
    session: 's1',
    run: 1,
    isResume: false,
    launch: { gatePrefix: GATE },
    consultTrace: async () => ({ events: [], headSeq: 0 }),
    hasRead: (p) => read.has(p),
    readHash: () => undefined,
    nativeTools: [],
    emit: (kind, data) => emitted.push({ kind, data }),
    requestApproval: async () => 'granted',
    accessOf: () => undefined,
    previewAction: async () => undefined,
  }
}

/** Run one decide with a fixed derived map + a seeded read-view. */
async function run(map: Map<string, string[]>, read: Set<string>, tool: string) {
  const decide = toolPreconditionDecide({ workspace: '/ws', derive: async () => map })
  const ctx = fakeCtx(read)
  const decision = await decide({ tool, input: {} }, ctx)
  return { decision, emitted: ctx.emitted }
}

const ONE = () => new Map([['dry_run_type', [GUIDE]]])

describe('tool-precondition mediator (loadable)', () => {
  it('denies a gate tool whose precondition file is unread, pointing at it by basename', async () => {
    const { decision, emitted } = await run(ONE(), new Set(), `${GATE}dry_run_type`)
    expect(decision.kind).toBe('deny')
    expect(denyReason(decision)).toMatch(/schema-induction\.md/)
    expect(denyReason(decision)).toMatch(/dry_run_type/)
    expect(emitted).toEqual([
      { kind: 'tool_denied', data: { tool: `${GATE}dry_run_type`, input: {}, reason: expect.stringMatching(/schema-induction/), belt: 'hook' } },
    ])
  })

  it('allows once the precondition file is read/served', async () => {
    const { decision, emitted } = await run(ONE(), new Set([GUIDE]), `${GATE}dry_run_type`)
    expect(decision).toEqual({ kind: 'allow' })
    expect(emitted).toHaveLength(0)
  })

  it('allows a gate tool with no declared precondition', async () => {
    const { decision } = await run(ONE(), new Set(), `${GATE}read_file_pinned`)
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('ignores non-gate tools (wrong / missing prefix)', async () => {
    expect((await run(ONE(), new Set(), 'dry_run_type')).decision).toEqual({ kind: 'allow' })
    expect((await run(ONE(), new Set(), 'Bash')).decision).toEqual({ kind: 'allow' })
  })

  it('denies when ANY of several required files is unread', async () => {
    const map = new Map([['dry_run_type', [GUIDE, '/pkg/guides/other.md']]])
    const { decision } = await run(map, new Set([GUIDE]), `${GATE}dry_run_type`) // only the first is read
    expect(decision.kind).toBe('deny')
    expect(denyReason(decision)).toMatch(/other\.md/)
    expect(denyReason(decision)).not.toMatch(/schema-induction/)
  })

  it('allows (fail-open) when the map cannot be derived yet (no engine)', async () => {
    const decide = toolPreconditionDecide({ workspace: '/ws', derive: async () => undefined })
    const d = await decide({ tool: `${GATE}dry_run_type`, input: {} }, fakeCtx(new Set()))
    expect(d).toEqual({ kind: 'allow' })
  })
})

describe('derivePreconditions (G2 self-derivation from the broker)', () => {
  const brokerWith = (subtypes: unknown[], calls: { op: string; args?: unknown }[] = []): PluginBroker => ({
    available: () => true,
    mutate: async () => ({}),
    read: async (op, args) => {
      calls.push({ op, args })
      if (op === 'subtypes') return { type: 'response', ready: true, result: { subtypes } }
      if (op === 'resolve_target') return { type: 'response', ready: true, result: { path: GUIDE } }
      return {}
    },
  })

  it('builds base-tool -> resolved-paths, skipping tools with no precondition', async () => {
    const calls: { op: string; args?: unknown }[] = []
    const broker = brokerWith(
      [
        {
          name: 'mcp.tool.dry_run_type',
          source: { file: '/ws/pkg/type/mcp.tool.dry_run_type.type.yaml' },
          meta_blocks: [{ type_name: 'read-precondition-meta::au-mcp-sdk', body: [{ name: 'onFiles', value: ['[[schema-induction]]'] }] }],
        },
        { name: 'mcp.tool.read_file_pinned', source: { file: '/ws/pkg/type/mcp.tool.read_file_pinned.type.yaml' }, meta_blocks: [] },
      ],
      calls,
    )
    const map = await derivePreconditions(broker, '/ws')
    expect(map).toBeDefined()
    expect(map!.get('dry_run_type')).toEqual([GUIDE])
    expect(map!.has('read_file_pinned')).toBe(false)
    // origin is the def file made workspace-relative; the wikilink is stripped to its bare target.
    expect(calls).toContainEqual({ op: 'resolve_target', args: { target: 'schema-induction', origin: 'pkg/type/mcp.tool.dry_run_type.type.yaml' } })
  })

  it('returns undefined when no engine is reachable (so the caller can retry, not memoize empty)', async () => {
    const noEngine: PluginBroker = { available: () => false, read: async () => ({}), mutate: async () => ({}) }
    expect(await derivePreconditions(noEngine, '/ws')).toBeUndefined()
    expect(await derivePreconditions(undefined, '/ws')).toBeUndefined()
  })
})
