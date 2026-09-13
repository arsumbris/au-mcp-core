import { describe, it, expect } from 'vitest'
import { createPlugin } from '../src/requiredScope-check.ts'
import type { PluginContext, PluginBroker, SessionScope, SessionStartContext, EngineFrame } from '@arsumbris/au-mcp-sdk'

// requiredScope-check (decision 2609071712): at session-open, walk mounted mcp.tool/mcp.hook defs that
// declare required-scope-meta, and warn per required ref that is NOT MOUNTED or MOUNTED-BUT-INACTIVE,
// consulting ctx.scope. These tests drive onSessionStart(ctx) over a fake broker + a fixture scope.

/** A def carrying a required-scope-meta with the given requires refs. */
function def(name: string, requires: string[]) {
  return { name, meta_blocks: [{ type_name: 'required-scope-meta::au-mcp-sdk', body: [{ name: 'requires', value: requires }] }] }
}

/** Fake broker: `subtypes` returns the given defs per base; anything else empty. */
function fakeBroker(byBase: Record<string, unknown[]>, opts: { available?: boolean } = {}): PluginBroker {
  return {
    available: () => opts.available ?? true,
    read: async (op: string, args?: Record<string, unknown>): Promise<EngineFrame> => {
      if (op === 'subtypes') return { result: { subtypes: byBase[String(args?.base)] ?? [] } }
      return { result: [] }
    },
    mutate: async () => ({}),
  }
}

function scopeOf(p: Partial<SessionScope>): SessionScope {
  return {
    tools: { active: [], mounted: [] },
    skills: { active: [], mounted: [] },
    members: [],
    ...p,
  }
}

function ctxWith(broker: PluginBroker | undefined, scope: SessionScope): SessionStartContext {
  return {
    session: 's1',
    run: 1,
    isResume: false,
    launch: {},
    consultTrace: async () => ({ events: [], headSeq: 0 }),
    broker,
    scope,
    emit: () => {},
  } as SessionStartContext
}

const hook = createPlugin({ workspace: '/ws' } as PluginContext)

async function inject(byBase: Record<string, unknown[]>, scope: SessionScope): Promise<string | undefined> {
  const r = await hook.onSessionStart!(ctxWith(fakeBroker(byBase), scope))
  return r?.inject?.[0]
}

describe('requiredScope-check session-start hook', () => {
  it('satisfied requirement -> no inject (ref is an active tool)', async () => {
    const out = await inject(
      { 'mcp.tool': [def('mcp.tool.au_writer', ['[[mcp.tool.au_declare::au-provenance]]'])] },
      scopeOf({ tools: { active: ['au_declare'], mounted: ['au_declare'] } }),
    )
    expect(out).toBeUndefined()
  })

  it('warns NOT MOUNTED when the ref is absent from every scope set', async () => {
    const out = await inject(
      { 'mcp.tool': [def('mcp.tool.au_writer', ['[[mcp.tool.au_declare::au-provenance]]'])] },
      scopeOf({ tools: { active: ['read_file_pinned'], mounted: ['read_file_pinned'] } }),
    )
    expect(out).toBe('⚠ Scope gaps (requiredScope):\n\n- au_writer expects au_declare in scope — NOT MOUNTED in this workspace.')
  })

  it('warns NOT ACTIVE when the ref is mounted but excluded by the profile', async () => {
    const out = await inject(
      { 'mcp.tool': [def('mcp.tool.au_writer', ['[[mcp.tool.au_declare]]'])] },
      scopeOf({ tools: { active: ['read_file_pinned'], mounted: ['read_file_pinned', 'au_declare'] } }),
    )
    expect(out).toBe(
      '⚠ Scope gaps (requiredScope):\n\n- au_writer expects au_declare in scope — mounted but NOT ACTIVE this session (excluded by the profile\'s allowlist).',
    )
  })

  it('a member ref is satisfied by ctx.scope.members', async () => {
    const out = await inject(
      { 'mcp.hook': [def('mcp.hook.my_hook', ['[[au-provenance]]'])] },
      scopeOf({ members: ['au-provenance'] }),
    )
    expect(out).toBeUndefined()
  })

  it('checks both tool and hook bases, one line per unmet ref', async () => {
    const out = await inject(
      {
        'mcp.tool': [def('mcp.tool.t1', ['[[mcp.tool.gone_a]]'])],
        'mcp.hook': [def('mcp.hook.h1', ['[[mcp.tool.gone_b]]', '[[mcp.tool.read_file_pinned]]'])],
      },
      scopeOf({ tools: { active: ['read_file_pinned'], mounted: ['read_file_pinned'] } }),
    )
    expect(out).toContain('- t1 expects gone_a in scope — NOT MOUNTED')
    expect(out).toContain('- h1 expects gone_b in scope — NOT MOUNTED')
    expect(out).not.toContain('read_file_pinned') // satisfied ref omitted
  })

  it('no requires anywhere -> no inject', async () => {
    const out = await inject({ 'mcp.tool': [{ name: 'mcp.tool.plain' }] }, scopeOf({}))
    expect(out).toBeUndefined()
  })

  it('no broker / down engine -> no inject', async () => {
    expect(await hook.onSessionStart!(ctxWith(undefined, scopeOf({})))).toBeUndefined()
    const down = await hook.onSessionStart!(ctxWith(fakeBroker({}, { available: false }), scopeOf({})))
    expect(down).toBeUndefined()
  })
})
