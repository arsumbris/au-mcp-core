import { describe, it, expect } from 'vitest'
import { createPlugin } from '../src/repo-overview.ts'
import type { PluginContext, PluginBroker, SessionStartContext, EngineFrame } from '@arsumbris/au-mcp-sdk'

// The repo-overview session-start hook (decision 2609020302). Config-less: at session-open it reads
// the mounted members (+ role) and each README's `tldr` over a read-only broker, and injects a
// tiered overview — FULL blocks for editable repos, a COMPACT name line for discover, a COUNT for
// deps, plus a tool hint. These tests drive onSessionStart(ctx) over a fake broker returning
// `members` + `instances_of` frames.

type Member = { repo: string; role?: 'entry' | 'edit' | 'discover' | 'dep'; editable?: boolean; disabled?: boolean }
type Readme = { member: string; tldr?: string }

function fakeBroker(
  members: Member[],
  readmes: Readme[],
  opts: { available?: boolean; membersError?: boolean } = {},
): PluginBroker {
  return {
    available: () => opts.available ?? true,
    read: async (op: string): Promise<EngineFrame> => {
      if (op === 'members') {
        if (opts.membersError) return { type: 'error', result: null }
        return { result: members }
      }
      if (op === 'instances_of') {
        return {
          result: readmes.map((r) => ({
            path: `/ws/${r.member}/README.md`,
            member: r.member,
            fields: r.tldr === undefined ? {} : { tldr: r.tldr },
          })),
        }
      }
      return { result: [] }
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
const HINT =
  'To get details: au_members lists every member with its role; ' +
  "au_follow [[README::<repo>]] or read_file_pinned reads one repo's README; " +
  'au_instances_of { ofType: "au.engine.readme::au-engine" } lists all README tldrs.'

async function inject(members: Member[], readmes: Readme[]): Promise<string | undefined> {
  const r = await hook.onSessionStart!(ctxWith(fakeBroker(members, readmes)))
  return r?.inject?.[0]
}

describe('repo-overview session-start hook', () => {
  it('tiers by role: full editable blocks, compact discover names, a dep count, then the hint', async () => {
    const out = await inject(
      [
        { repo: 'au-mcp', role: 'edit', editable: true },
        { repo: 'ws', role: 'entry', editable: true },
        { repo: 'au-host-sdk', role: 'discover' },
        { repo: 'au-type-knowledge', role: 'discover' },
        { repo: 'dep-a', role: 'dep' },
        { repo: 'dep-b', role: 'dep' },
        { repo: 'dep-c', role: 'dep' },
      ],
      [
        { member: 'au-mcp', tldr: 'The kernel daemon.' },
        // 'ws' (the entry) has no README -> name fallback + (no README).
      ],
    )
    expect(out).toBe(
      [
        'Generated Repository Overview:',
        '',
        'EDITABLE REPOSITORIES (the surfaces you author):',
        '',
        '[[::au-mcp]]\ntldr: The kernel daemon.\nreadme: [[README::au-mcp]]',
        '',
        'Editable, no README yet: ws',
        '',
        'DISCOVERY-MOUNTED REPOSITORIES (pinned for type discovery):',
        'au-host-sdk, au-type-knowledge',
        '',
        '3 DEPENDENCIES mounted (consumed type-dependencies).',
        '',
        HINT,
      ].join('\n'),
    )
  })

  it('singularizes a lone dependency', async () => {
    const out = await inject([{ repo: 'x', role: 'dep' }, { repo: 'e', role: 'edit', editable: true }], [])
    expect(out).toContain('1 DEPENDENCY mounted (consumed type-dependencies).')
  })

  it('omits empty tiers (editable-only workspace still gets the hint)', async () => {
    const out = await inject([{ repo: 'au-mcp', role: 'edit', editable: true }], [{ member: 'au-mcp', tldr: 'K.' }])
    expect(out).toBe(
      [
        'Generated Repository Overview:',
        '',
        'EDITABLE REPOSITORIES (the surfaces you author):',
        '',
        '[[::au-mcp]]\ntldr: K.\nreadme: [[README::au-mcp]]',
        '',
        HINT,
      ].join('\n'),
    )
  })

  it('falls back to the repo name on a blank tldr', async () => {
    const out = await inject([{ repo: 'au-blank', role: 'edit', editable: true }], [{ member: 'au-blank', tldr: '   ' }])
    expect(out).toContain('[[::au-blank]]\ntldr: au-blank\nreadme: [[README::au-blank]]')
  })

  it('skips a disabled member', async () => {
    const out = await inject(
      [
        { repo: 'au-live', role: 'edit', editable: true },
        { repo: 'au-off', role: 'edit', editable: true, disabled: true },
      ],
      [{ member: 'au-live', tldr: 'Live.' }],
    )
    expect(out).toContain('[[::au-live]]')
    expect(out).not.toContain('au-off')
  })

  it('injects nothing when the engine is unavailable, the members read errors, or there are no members', async () => {
    expect(await hook.onSessionStart!(ctxWith(fakeBroker([{ repo: 'x', role: 'edit', editable: true }], [], { available: false })))).toBeUndefined()
    expect(await hook.onSessionStart!(ctxWith(fakeBroker([{ repo: 'x', role: 'edit', editable: true }], [], { membersError: true })))).toBeUndefined()
    expect(await hook.onSessionStart!(ctxWith(fakeBroker([], [])))).toBeUndefined()
    expect(await hook.onSessionStart!(ctxWith(undefined))).toBeUndefined()
  })
})
