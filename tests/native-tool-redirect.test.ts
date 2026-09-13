import { describe, it, expect } from 'vitest'
import { redirectDecide } from '../src/native-tool-redirect.ts'
import type { MediationContext, NativeTool, PendingAction, Decision } from '@arsumbris/au-mcp-sdk'

// The redirect (native-tool allowlist) plugin as a loadable mediator (plan 2608261532, Phase 5.3).
// It reads ctx.launch.nativeToolAllowlist (the tri-state whitelist) + ctx.nativeTools, so these
// tests drive the decide over a mock MediationContext. A TRUE whitelist: nothing is implicitly
// allowed, and the gate tools stay available (they are the gate, not natives).

const GATE = 'mcp__au__'
const NATIVES: NativeTool[] = [{ name: 'Bash', gateEquivalent: `${GATE}bash` }, { name: 'WebFetch' }]

function fakeCtx(
  nativeToolAllowlist: string[] | undefined,
  gated = true,
): MediationContext & { emitted: { kind: string; data: unknown }[] } {
  const emitted: { kind: string; data: unknown }[] = []
  return {
    emitted,
    session: 's1',
    run: 1,
    isResume: false,
    launch: { ...(gated ? { gatePrefix: GATE } : {}), nativeToolAllowlist },
    consultTrace: async () => ({ events: [], headSeq: 0 }),
    hasRead: () => false,
    readHash: () => undefined,
    nativeTools: NATIVES,
    emit: (kind, data) => emitted.push({ kind, data }),
    requestApproval: async () => 'granted',
    accessOf: () => undefined,
    previewAction: async () => undefined,
  }
}

const decide = redirectDecide()
const useInstead = (d: Decision) => (d.kind === 'deny' ? d.useInstead : undefined)
function run(tool: string, allowlist: string[] | undefined, gated = true) {
  const ctx = fakeCtx(allowlist, gated)
  const d = decide({ tool, input: {} } as PendingAction, ctx)
  return { d, emitted: ctx.emitted }
}

describe('redirect (native-tool allowlist enforcer)', () => {
  it('is inert when no allowlist is set — every native tool allowed', () => {
    expect(run('Bash', undefined).d).toEqual({ kind: 'allow' })
    expect(run('WebFetch', undefined).d).toEqual({ kind: 'allow' })
  })

  it('allows the au_* gate tools regardless of the allowlist (they are the gate, not natives)', () => {
    expect(run(`${GATE}read_file_pinned`, []).d).toEqual({ kind: 'allow' })
    expect(run(`${GATE}write_file`, ['Bash']).d).toEqual({ kind: 'allow' })
  })

  it('denies a native not in the allowlist, pointing at its gate equivalent + recording the deny', () => {
    const { d, emitted } = run('Bash', [])
    expect(d.kind).toBe('deny')
    expect(useInstead(d)).toBe(`${GATE}bash`)
    expect(emitted).toEqual([
      { kind: 'tool_denied', data: { tool: 'Bash', input: {}, reason: expect.stringMatching(/not in this session's native-tool allowlist/), belt: 'hook' } },
    ])
  })

  it('allows a native that IS in the allowlist', () => {
    expect(run('WebFetch', ['WebFetch']).d).toEqual({ kind: 'allow' })
    expect(run('Bash', ['Bash', 'WebFetch']).d).toEqual({ kind: 'allow' })
  })

  it('an empty allowlist denies EVERY native — no exceptions (even WebFetch)', () => {
    expect(run('WebFetch', []).d.kind).toBe('deny') // no hardcoded pass-through
    expect(run('Bash', []).d.kind).toBe('deny')
  })

  it('a denied native with no gate equivalent gets a generic reason (no useInstead)', () => {
    const { d } = run('WebFetch', []) // WebFetch has no gateEquivalent
    expect(d.kind).toBe('deny')
    expect(useInstead(d)).toBeUndefined()
  })

  it('is inert without a gate prefix (no gate to redirect to)', () => {
    expect(run('Bash', [], false).d).toEqual({ kind: 'allow' })
  })
})
