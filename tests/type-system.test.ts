import { describe, it, expect } from 'vitest'
import type { PluginBroker, EngineFrame } from '@arsumbris/au-mcp-sdk'
import { engineTools } from '../src/engine-reads.ts'

// au_type_system reads the MOUNTED au-mcp-type-knowledge `reference-atom` instances (decisions
// 2607031829 / 2607031934 / 2607052009), NOT the engine's dropped compiled-in `type_system_reference`
// read. `reference-atom` is a positive, `::repo`-owned identity — queried directly, not `doc`-minus-guides.
// Two engine reads: `instances_of {type: 'reference-atom::au-mcp-type-knowledge'}` for the atom set,
// `content {path}` per atom. This fake broker serves both, returning schema-6 match records. An atom's
// default body is `<name>-BODY`; `error` fails its content read; an empty atom list models the package
// NOT being mounted (no `reference-atom` instances).
const REFERENCE_ATOM_TYPE = 'reference-atom::au-mcp-type-knowledge'
type Atom = { name: string; body?: string; error?: boolean }

function broker(atoms: Atom[]): PluginBroker {
  const pathOf = (a: Atom) => `reference/${a.name}.md`
  const byPath = new Map(atoms.map((a) => [pathOf(a), a]))
  return {
    mutate: async () => ({}),
    available: () => true,
    async read(op, args): Promise<EngineFrame> {
      if (op === 'instances_of' && (args as { type?: string } | undefined)?.type === REFERENCE_ATOM_TYPE) {
        return {
          type: 'response',
          ready: true,
          result: atoms.map((a) => ({
            path: pathOf(a),
            claim: ['reference-atom'],
            name: 'reference-atom',
            hash: 'deadbeef',
            owners: ['au-mcp-type-knowledge'],
            claimed: true,
            inherited: false,
          })),
        }
      }
      if (op === 'content') {
        const a = byPath.get((args as { path?: string } | undefined)?.path ?? '')
        if (!a || a.error) return { type: 'error', ready: true, result: 'boom' }
        return { type: 'response', ready: true, result: { text: `---\ntype: reference-atom\n---\n${a.body ?? `${a.name}-BODY`}` } }
      }
      return { type: 'response', ready: true, result: null }
    },
  }
}

function typeSystemTool(b: PluginBroker) {
  const tool = engineTools(b).find((p) => p.manifest.id === 'mcp.au_type_system')
  if (!tool?.invoke) throw new Error('au_type_system not registered')
  return tool.invoke
}

describe('au_type_system full bundle', () => {
  const atoms = (): Atom[] => [
    { name: 'moc - type system', body: 'MOC-BODY' },
    { name: 'type-def' },
    { name: 'type-def sealed' },
    { name: 'spec - diagnostic codes' },
  ]

  it('full:true inlines the moc + every atom EXCEPT the diagnostics catalog', async () => {
    const invoke = typeSystemTool(broker(atoms()))
    const s = String((await invoke({ full: true })).content)
    expect(s).toContain('MOC-BODY') // the moc, once
    expect(s).toContain('---- [type-def]') // a conceptual atom inlined under its header
    expect(s).toContain('type-def-BODY')
    expect(s).toContain('type-def sealed-BODY')
    expect(s).not.toContain('spec - diagnostic codes-BODY') // catalog excluded (reference-only)
    expect(s).not.toContain('---- [moc - type system]') // moc not re-inlined as an atom
  })

  it('skips a flaky atom but keeps the rest', async () => {
    const a = atoms()
    a[1].error = true // the `type-def` atom's content read fails
    const s = String((await typeSystemTool(broker(a))({ full: true })).content)
    expect(s).not.toContain('type-def-BODY') // the failing atom dropped
    expect(s).toContain('type-def sealed-BODY') // the rest survive
  })

  it('no arg returns the cheap map: the moc + every atom name, sorted', async () => {
    const res = await typeSystemTool(broker(atoms()))({})
    expect(res.content).toEqual({
      moc: 'MOC-BODY',
      specs: ['moc - type system', 'spec - diagnostic codes', 'type-def', 'type-def sealed'],
    })
  })

  it('by-name returns one atom (frontmatter stripped)', async () => {
    const res = await typeSystemTool(broker(atoms()))({ name: 'type-def sealed' })
    expect(res.content).toBe('type-def sealed-BODY')
    expect(res.isError).not.toBe(true)
  })

  it('errors clearly when the reference package is not mounted (no doc atoms)', async () => {
    const res = await typeSystemTool(broker([]))({})
    expect(res.isError).toBe(true)
    expect(String(res.content)).toContain('au-mcp-type-knowledge) is not mounted')
  })
})
