import { describe, it, expect } from 'vitest'
import { readBeforeWriteDecide } from '../src/read-guard.ts'
import type { MediationContext, PluginBroker, PendingAction, Decision } from '@arsumbris/au-mcp-sdk'

// The read-before-write guard as a loadable plugin (plan 2608261532, Phase 5.1). It reads the
// read-time hash from ctx.readHash (Phase-4 accessor) and the current hash from ctx.broker — so
// these tests drive the decide over a mock MediationContext, seeding the read-view and the broker's
// `content` reply, rather than injecting a readView map + currentHash resolver (the kernel form).

const PREFIX = 'mcp__au__'

/** A read-only PluginBroker whose `content` read reports `hash` (null => no engine / unreadable). */
function brokerReturning(hash: string | null): PluginBroker {
  return {
    available: () => true,
    mutate: async () => ({}),
    read: async () => (hash === null ? { ready: true, result: null } : { type: 'response', ready: true, result: { hash } }),
  }
}

/**
 * A MediationContext seeded with the session read-view (path -> read-time hash) and the current
 * on-disk hash the broker will report. `gated` (default true) puts the gate prefix on the launch;
 * pass false for the inert (ungated-session) case — SessionLaunch.gatePrefix is then absent.
 */
function fakeCtx(
  readView: Map<string, string>,
  currentHash: string | null,
  gated = true,
): MediationContext & { denials: { kind: string; data: unknown }[] } {
  const denials: { kind: string; data: unknown }[] = []
  return {
    denials,
    session: 's1',
    run: 1,
    isResume: false,
    launch: { ...(gated ? { gatePrefix: PREFIX } : {}) },
    consultTrace: async () => ({ events: [], headSeq: 0 }),
    hasRead: (p) => readView.has(p),
    readHash: (p) => readView.get(p),
    nativeTools: [],
    broker: brokerReturning(currentHash),
    emit: (kind, data) => denials.push({ kind, data }),
    requestApproval: async () => 'granted',
    accessOf: () => undefined,
    previewAction: async () => undefined,
  }
}

const reasonOf = (d: Decision) => (d.kind === 'deny' ? d.reason : '')
const write = (path: string, extra: Record<string, unknown> = {}): PendingAction => ({
  tool: `${PREFIX}write_file`,
  input: { file_path: path, content: 'x', ...extra },
})

// Default the existence check to "the file exists" so the EXISTING-file cases keep their meaning;
// the create case passes exists:false.
const decideWith = (exists: (p: string) => boolean = () => true) => readBeforeWriteDecide({ exists })

describe('read-before-write guard (loadable)', () => {
  it('denies overwriting an EXISTING path the session never read', async () => {
    const decide = decideWith(() => true)
    const ctx = fakeCtx(new Map(), 'h1')
    const d = await decide(write('/ws/a.md'), ctx)
    expect(d.kind).toBe('deny')
    expect(reasonOf(d)).toMatch(/read .* before overwriting/)
    expect(ctx.denials).toHaveLength(1) // the deny is recorded through the bus (tool_denied)
  })

  it('ALLOWS creating a new file (target does not exist — no clobber, no prior read needed) — P7-O9', async () => {
    const decide = decideWith(() => false)
    const d = await decide(write('/ws/type/note.type.yaml'), fakeCtx(new Map(), null))
    expect(d.kind).toBe('allow')
  })

  it('allows an overwrite when the read-view hash still matches disk', async () => {
    const decide = decideWith(() => true)
    const d = await decide(write('/ws/a.md'), fakeCtx(new Map([['/ws/a.md', 'h1']]), 'h1'))
    expect(d.kind).toBe('allow')
  })

  it('denies an overwrite when the file changed since the read', async () => {
    const decide = decideWith(() => true)
    const d = await decide(write('/ws/a.md'), fakeCtx(new Map([['/ws/a.md', 'h1']]), 'h2'))
    expect(d.kind).toBe('deny')
    expect(reasonOf(d)).toMatch(/changed on disk/)
  })

  it('allows when the caller supplies its own expected_hash (does its own CAS)', async () => {
    const decide = decideWith(() => true)
    const d = await decide(write('/ws/a.md', { expected_hash: 'h9' }), fakeCtx(new Map(), null))
    expect(d.kind).toBe('allow')
  })

  it('does not gate edit_file (the channel self-guards via old_string)', async () => {
    const decide = decideWith(() => true)
    const action: PendingAction = { tool: `${PREFIX}edit_file`, input: { file_path: '/ws/a.md', old_string: 'x', new_string: 'y' } }
    expect((await decide(action, fakeCtx(new Map(), null))).kind).toBe('allow')
  })

  it('ignores non-gate tools', async () => {
    const decide = decideWith(() => true)
    expect((await decide({ tool: 'Bash', input: { command: 'ls' } }, fakeCtx(new Map(), null))).kind).toBe('allow')
  })

  it('is inert without a gate prefix', async () => {
    const decide = decideWith(() => true)
    expect((await decide(write('/ws/a.md'), fakeCtx(new Map(), null, false))).kind).toBe('allow')
  })
})
