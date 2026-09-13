// Engine-read plugins (mcp.au_*) — MOVED verbatim from au-mcp's plugins.test.ts as the tools
// migrated to au-mcp-core (plan 2608261532 Phase 3). Bodies are unchanged: engine-reads.ts still
// exports engineTools(), so the tests exercise the same closures; only the broker type is now the
// SDK's PluginBroker (was au-mcp's EngineBroker), and the mock socketPath excess-props are dropped.

import { describe, it, expect } from 'vitest'
import type { PluginBroker, CallableResult } from '@arsumbris/au-mcp-sdk'
import { engineTools } from '../src/engine-reads.ts'

describe('engine-read plugins', () => {
  const fakeBroker = (available: boolean, read?: PluginBroker['read']): PluginBroker => ({
    mutate: async () => ({}),
    available: () => available,
    read: read ?? (async (op) => ({ type: 'response', ready: true, result: { op } })),
  })

  it('are ALWAYS registered — advertisement is decoupled from engine availability at startup (P7-O4)', () => {
    // The old gate omitted the whole set when the engine socket was absent at startup,
    // so a startup race permanently hid every au_* tool. Now they always register.
    const ids = engineTools(fakeBroker(false)).map((p) => p.manifest.id)
    expect(ids).toContain('mcp.au_types')
    expect(engineTools(fakeBroker(false)).length).toBe(engineTools(fakeBroker(true)).length)
  })

  it('fail GRACEFULLY at call time when the engine is unreachable (read throws)', async () => {
    const down = fakeBroker(false, async () => {
      throw new Error('engine read connect failed')
    })
    const types = engineTools(down).find((p) => p.manifest.id === 'mcp.au_types')!
    const res = (await types.invoke!({})) as CallableResult
    expect(res.isError).toBe(true)
  })

  it('read through the broker when an engine is present', async () => {
    // au_type_tree is a plain readTool pass-through (au_types is now a shaped summary/paging tool).
    const tools = engineTools(fakeBroker(true))
    const tree = tools.find((p) => p.manifest.id === 'mcp.au_type_tree')
    expect(tree).toBeDefined()
    const res = (await tree!.invoke!({})) as CallableResult
    expect(res.content).toEqual({ op: 'type_tree' })
  })

  it('readTool returns a clean null on a legitimate null result, not the raw wire frame (P1-A4)', async () => {
    // The engine returns { ...envelope..., result: null } for an absent atom / unresolved
    // path. `?? frame` used to leak the whole envelope to the agent (dogfood: au_type_system).
    const nullBroker = fakeBroker(true, async () => ({ type: 'response', ready: true, version: 52, result: null }))
    const tree = engineTools(nullBroker).find((p) => p.manifest.id === 'mcp.au_type_tree')!
    const res = (await tree.invoke!({})) as CallableResult
    expect(res.content).toBeNull()
    expect(res.isError).toBeUndefined()
  })

  // F3a: au_typed distills the `resolved` read into a discoverability answer.
  const brokerResolving = (result: unknown): PluginBroker => ({
    mutate: async () => ({}),
    available: () => true,
    read: async () => ({ type: 'response', ready: true, result }),
  })

  it('au_typed reports a plain note as not typed (resolved == null)', async () => {
    const tool = engineTools(brokerResolving(null)).find((p) => p.manifest.id === 'mcp.au_typed')
    const res = (await tool!.invoke!({ path: 'note.md' })) as CallableResult
    expect(res.content).toEqual({ path: 'note.md', typed: false })
  })

  it('au_typed reports a typed instance with its claim and resolution', async () => {
    const broker = brokerResolving({ resolved: true, claim: ['session-log'], closure: ['session-log', 'base'] })
    const tool = engineTools(broker).find((p) => p.manifest.id === 'mcp.au_typed')
    const res = (await tool!.invoke!({ path: 'x.session.yaml' })) as CallableResult
    expect(res.content).toEqual({
      path: 'x.session.yaml',
      typed: true,
      kind: 'instance',
      claim: ['session-log'],
      resolves: true,
      closure: ['session-log', 'base'],
    })
  })

  // P6-O10: a non-instance is disambiguated via resolve_target.kind (a type-def is not a plain note).
  const brokerKind = (resolvedResult: unknown, kind: string): PluginBroker => ({
    available: () => true,
    mutate: async () => ({}),
    read: async (op) =>
      op === 'resolve_target'
        ? { type: 'response', ready: true, result: { kind, path: '/ws/x', hash: 'h' } }
        : { type: 'response', ready: true, result: resolvedResult },
  })

  it('au_typed distinguishes a type-def from a plain note (resolve_target.kind)', async () => {
    const typeDef = engineTools(brokerKind(null, 'type-def'), '/ws').find((p) => p.manifest.id === 'mcp.au_typed')
    expect((await typeDef!.invoke!({ path: '/ws/type/x.type.yaml' })).content).toEqual({
      path: '/ws/type/x.type.yaml',
      typed: false,
      kind: 'type-def',
    })
    const note = engineTools(brokerKind(null, 'unclassified'), '/ws').find((p) => p.manifest.id === 'mcp.au_typed')
    expect((await note!.invoke!({ path: '/ws/notes/a.md' })).content).toEqual({
      path: '/ws/notes/a.md',
      typed: false,
      kind: 'unclassified',
    })
  })

  it('au_typed omits kind when no workspace is wired (kind unresolvable)', async () => {
    const note = engineTools(brokerResolving(null)).find((p) => p.manifest.id === 'mcp.au_typed')
    expect((await note!.invoke!({ path: 'note.md' })).content).toEqual({ path: 'note.md', typed: false })
  })

  it('au_typed requires a path', async () => {
    const tool = engineTools(fakeBroker(true)).find((p) => p.manifest.id === 'mcp.au_typed')
    const res = (await tool!.invoke!({})) as CallableResult
    expect(res.isError).toBe(true)
  })

  // The three LISTING duals (decision 2607281848): what CAN be addressed, one per wikilink
  // fragment position. The contract that matters is NULL-IS-NOT-EMPTY — an unresolved target
  // answers null, a resolved file carrying nothing answers []. Conflating them would make an
  // agent read "no such file" as "no headings", so both are asserted explicitly.
  type ListCall = { op: string; args: Record<string, unknown> }
  const listBroker = (result: unknown, calls: ListCall[] = []): PluginBroker => ({
    mutate: async () => ({}),
    available: () => true,
    read: async (op, args = {}) => {
      calls.push({ op, args })
      return { type: 'response', ready: true, result }
    },
  })
  const listTool = (id: string, b: PluginBroker, ws?: string) =>
    engineTools(b, ws).find((p) => p.manifest.id === id)!

  it('au_anchors requires target, and passes origin through only when given', async () => {
    expect(((await listTool('mcp.au_anchors', listBroker([])).invoke!({})) as CallableResult).isError).toBe(true)
    const calls: ListCall[] = []
    await listTool('mcp.au_anchors', listBroker([], calls)).invoke!({ target: 'note' })
    expect(calls[0]).toEqual({ op: 'anchors', args: { target: 'note' } })
    await listTool('mcp.au_anchors', listBroker([], calls)).invoke!({ target: 'note', origin: '/ws/a.md' })
    expect(calls[1]).toEqual({ op: 'anchors', args: { target: 'note', origin: '/ws/a.md' } })
  })

  it('au_anchors keeps null (unresolved target) distinct from [] (resolved, no headings)', async () => {
    const nul = (await listTool('mcp.au_anchors', listBroker(null)).invoke!({ target: 'nope' })) as CallableResult
    expect(nul.content).toBeNull()
    const empty = (await listTool('mcp.au_anchors', listBroker([])).invoke!({ target: 'bare' })) as CallableResult
    expect(empty.content).toEqual([])
  })

  it('au_block_ids requires target and routes to block_ids, carrying the kind vocabulary through', async () => {
    expect(((await listTool('mcp.au_block_ids', listBroker([])).invoke!({})) as CallableResult).isError).toBe(true)
    const calls: ListCall[] = []
    // Both id surfaces in one stream, and a duplicate id — the array is NOT id-unique.
    const rows = [
      { id: 'r1', kind: 'record', type_claim: 'decision', span: { start: 4, end: 9 } },
      { id: 'b1', kind: 'typed_block', span: { start: 40, end: 52 } },
      { id: 'b1', kind: 'marker', span: { start: 90, end: 93 } },
    ]
    const res = (await listTool('mcp.au_block_ids', listBroker(rows, calls)).invoke!({ target: 'note' })) as CallableResult
    expect(calls[0]).toEqual({ op: 'block_ids', args: { target: 'note' } })
    expect(res.content).toEqual(rows)
    // A `^^` referent is satisfied by record/typed_block, never marker — the agent filters on kind.
    const referentable = rows.filter((r) => r.kind === 'record' || r.kind === 'typed_block')
    expect(referentable.map((r) => r.id)).toEqual(['r1', 'b1'])
  })

  it('au_block_ids keeps null distinct from []', async () => {
    const nul = (await listTool('mcp.au_block_ids', listBroker(null)).invoke!({ target: 'nope' })) as CallableResult
    expect(nul.content).toBeNull()
    const empty = (await listTool('mcp.au_block_ids', listBroker([])).invoke!({ target: 'bare' })) as CallableResult
    expect(empty.content).toEqual([])
  })

  it('au_files takes no required arg and omits absent optionals rather than sending undefined', async () => {
    const calls: ListCall[] = []
    await listTool('mcp.au_files', listBroker([], calls)).invoke!({})
    expect(calls[0]).toEqual({ op: 'files', args: {} })
    await listTool('mcp.au_files', listBroker([], calls)).invoke!({ repo: 'garden', scope: 'own', limit: 10, offset: 5 })
    expect(calls[1]).toEqual({ op: 'files', args: { repo: 'garden', scope: 'own', limit: 10, offset: 5 } })
  })

  it('au_files surfaces assets, the half no parsed-file listing reaches', async () => {
    const rows = [
      { path: '/ws/g/roses.md', stem: 'roses', repo: 'g', kind: 'instance' },
      { path: '/ws/g/diagram.png', stem: 'diagram', repo: 'g', kind: 'asset' },
    ]
    const res = (await listTool('mcp.au_files', listBroker(rows)).invoke!({})) as CallableResult
    expect(res.content).toEqual(rows)
    expect((res.content as typeof rows).some((r) => r.kind === 'asset')).toBe(true)
  })

  // au_follow: parse the wikilink, dispatch by fragment, normalize the result.
  type FollowCall = { op: string; args: Record<string, unknown> }
  const followBroker = (results: Record<string, unknown>, calls: FollowCall[] = []): PluginBroker => ({
    mutate: async () => ({}),
    available: () => true,
    read: async (op, args = {}) => {
      calls.push({ op, args })
      return { type: 'response', ready: true, result: op in results ? results[op] : null }
    },
  })
  const auFollow = (b: PluginBroker, ws?: string) =>
    engineTools(b, ws).find((p) => p.manifest.id === 'mcp.au_follow')!

  it('au_follow requires target and origin', async () => {
    const t = auFollow(fakeBroker(true))
    expect(((await t.invoke!({ origin: 'a.md' })) as CallableResult).isError).toBe(true)
    expect(((await t.invoke!({ target: 'b' })) as CallableResult).isError).toBe(true)
  })

  it('au_follow: a plain target routes to resolve_target and normalizes path+kind', async () => {
    const calls: FollowCall[] = []
    const b = followBroker(
      { resolve_target: { path: '/ws/content/b.md', kind: 'instance', source: null }, resolve_member: { repo: 'content' } },
      calls,
    )
    const res = (await auFollow(b).invoke!({ target: 'b', origin: 'content/a.md' })) as CallableResult
    expect(calls[0]).toEqual({ op: 'resolve_target', args: { target: 'b', origin: 'content/a.md' } })
    expect(res.content).toMatchObject({ resolved: true, path: '/ws/content/b.md', kind: 'instance', repo: 'content' })
  })

  it('au_follow: a ^block-id routes to resolve_block_id (separate arg) with a snippet peek', async () => {
    const calls: FollowCall[] = []
    const b = followBroker(
      {
        resolve_block_id: { file_path: '/ws/b.md', kind: 'marker', span: { line_col: { start: { line: 3 }, end: { line: 3 } } } },
        content: { text: '# B\n\nA paragraph. ^blk\n' },
        resolve_member: { repo: 'content' },
      },
      calls,
    )
    const res = (await auFollow(b).invoke!({ target: 'b^blk', origin: 'a.md' })) as CallableResult
    expect(calls[0]).toEqual({ op: 'resolve_block_id', args: { target: 'b', block_id: 'blk', origin: 'a.md' } })
    expect(res.content).toMatchObject({ resolved: true, path: '/ws/b.md', kind: 'marker', snippet: 'A paragraph. ^blk' })
  })

  it('au_follow: a ^^block-referent parses the BARE id + reports referent:true (correct ^^ handling)', async () => {
    const calls: FollowCall[] = []
    const b = followBroker({ resolve_block_id: { file_path: '/ws/b.md', kind: 'record', span: {} } }, calls)
    const res = (await auFollow(b).invoke!({ target: 'b^^blk', origin: 'a.md' })) as CallableResult
    // the BARE id (both carets stripped), NOT '^blk' — resolve_block_id takes the bare .id.
    expect(calls[0]).toEqual({ op: 'resolve_block_id', args: { target: 'b', block_id: 'blk', origin: 'a.md' } })
    expect(res.content).toMatchObject({ resolved: true, path: '/ws/b.md', referent: true })
  })

  // au_neighborhood: require `path`, forward the optional args through to the engine's
  // `neighborhood` read, and let the daemon own validation (kinds-past-depth-1, etc.).
  const auNeighborhood = (b: PluginBroker) =>
    engineTools(b).find((p) => p.manifest.id === 'mcp.au_neighborhood')!

  it('au_neighborhood requires path', async () => {
    const res = (await auNeighborhood(fakeBroker(true)).invoke!({ depth: 1 })) as CallableResult
    expect(res.isError).toBe(true)
  })

  it('au_neighborhood forwards path + present optional args to the neighborhood read, omitting absent ones', async () => {
    const calls: FollowCall[] = []
    const b = followBroker({ neighborhood: { nodes: [], edges: [], truncated: false, dropped: [] } }, calls)
    const res = (await auNeighborhood(b).invoke!({
      path: '/ws/moc.md',
      direction: 'out',
      depth: 2,
      kinds: ['field-reference', 'navigational'],
      body: true,
    })) as CallableResult
    // scope / max_nodes / content / instance were absent, so they must NOT appear in the args.
    expect(calls[0]).toEqual({
      op: 'neighborhood',
      args: { path: '/ws/moc.md', direction: 'out', depth: 2, kinds: ['field-reference', 'navigational'], body: true },
    })
    expect(res.content).toMatchObject({ nodes: [], edges: [], truncated: false })
  })

  it('au_neighborhood surfaces the daemon arg-validation error verbatim (kinds past depth 1)', async () => {
    // The engine owns the rule; the tool forwards and relays the error arm rather than re-deriving it.
    const b: PluginBroker = {
      mutate: async () => ({}),
      available: () => true,
      read: async () => ({ type: 'error', ready: true, error: 'kinds is required past depth 1' }) as never,
    }
    const res = (await auNeighborhood(b).invoke!({ path: '/ws/a.md', depth: 2 })) as CallableResult
    expect(res.isError).toBe(true)
    expect(String((res as { content?: unknown }).content)).toContain('kinds is required past depth 1')
  })

  it('au_neighborhood drops a non-string-array kinds rather than forwarding a malformed arg', async () => {
    const calls: FollowCall[] = []
    const b = followBroker({ neighborhood: { nodes: [], edges: [], truncated: false, dropped: [] } }, calls)
    await auNeighborhood(b).invoke!({ path: '/ws/a.md', kinds: 'field-reference' })
    // a scalar `kinds` is not a valid list; it is omitted, and the engine then applies its default.
    expect(calls[0]).toEqual({ op: 'neighborhood', args: { path: '/ws/a.md' } })
  })

  it('au_follow: a bare ^block-id reports referent:false', async () => {
    const b = followBroker({ resolve_block_id: { file_path: '/ws/b.md', kind: 'marker', span: {} } })
    const res = (await auFollow(b).invoke!({ target: 'b^blk', origin: 'a.md' })) as CallableResult
    expect(res.content).toMatchObject({ referent: false })
  })

  it('au_follow: a ::repo@commit pin re-embeds into the target (opaque passthrough)', async () => {
    const calls: FollowCall[] = []
    const b = followBroker({ resolve_target: { path: '/o/n.md', kind: 'instance', source: null } }, calls)
    await auFollow(b).invoke!({ target: 'note::other@abc123', origin: 'a.md' })
    expect(calls[0].args.target).toBe('note::other@abc123')
  })

  it('au_follow: a malformed wikilink fails with the parse error, never mis-resolves', async () => {
    const calls: FollowCall[] = []
    const res = (await auFollow(followBroker({}, calls)).invoke!({ target: 'b^^', origin: 'a.md' })) as CallableResult // empty block-id
    expect(res.isError).toBe(true)
    expect(String(res.content)).toContain('invalid wikilink target')
    expect(calls).toHaveLength(0) // failed BEFORE any read, not a silent mis-resolve
  })

  it('au_follow: a #anchor routes to resolve_anchor with kind=heading', async () => {
    const calls: FollowCall[] = []
    const b = followBroker(
      {
        resolve_anchor: { file_path: '/ws/b.md', span: { line_col: { start: { line: 3 }, end: { line: 3 } } } },
        content: { text: '# B\n\n## Some Heading\n' },
      },
      calls,
    )
    const res = (await auFollow(b).invoke!({ target: 'b#Some Heading', origin: 'a.md' })) as CallableResult
    expect(calls[0]).toEqual({ op: 'resolve_anchor', args: { target: 'b', anchor: 'Some Heading', origin: 'a.md' } })
    expect(res.content).toMatchObject({ resolved: true, path: '/ws/b.md', kind: 'heading', snippet: '## Some Heading' })
  })

  it('au_follow: a ::repo qualifier stays embedded in target (opaque passthrough)', async () => {
    const calls: FollowCall[] = []
    const b = followBroker({ resolve_target: { path: '/other/n.md', kind: 'instance', source: null } }, calls)
    await auFollow(b).invoke!({ target: 'note::other-repo', origin: 'a.md' })
    expect(calls[0].args.target).toBe('note::other-repo')
  })

  it('au_follow: an absolute origin is passed THROUGH (origin-scoped resolution)', async () => {
    const calls: FollowCall[] = []
    const b = followBroker({ resolve_target: { path: '/ws/b.md', kind: 'instance', source: null } }, calls)
    await auFollow(b, '/ws').invoke!({ target: 'b', origin: '/ws/content/a.md' })
    // The engine resolves an ABSOLUTE origin directly (origin-scoped navigation, message 260630130801);
    // the old relativize-against-workspace broke navigation from any cross-repo member mounted outside root.
    expect(calls[0].args.origin).toBe('/ws/content/a.md')
  })

  it('au_follow: a type-def in a bundle surfaces source.file as the openable path', async () => {
    const b = followBroker({
      resolve_target: {
        path: '/ws/type/x.yamls/x.type.yaml',
        kind: 'type-def',
        source: { file: '/ws/type/x.yamls', span: { start: 10, end: 20 } },
      },
    })
    const res = (await auFollow(b).invoke!({ target: 'x', origin: 'a.md' })) as CallableResult
    expect(res.content).toMatchObject({ resolved: true, path: '/ws/type/x.yamls', kind: 'type-def' })
  })

  it('au_follow: the local form [[^id]] resolves against the origin (its basename)', async () => {
    const calls: FollowCall[] = []
    const b = followBroker(
      { resolve_block_id: { file_path: '/ws/garden/roses.md', kind: 'marker', span: { line_col: { start: { line: 1 }, end: { line: 1 } } } } },
      calls,
    )
    // empty name + a fragment means "this file" — TARGET is the origin's basename (not ''); ORIGIN passes through absolute.
    await auFollow(b, '/ws').invoke!({ target: '^care-tip', origin: '/ws/garden/roses.md' })
    expect(calls[0]).toEqual({ op: 'resolve_block_id', args: { target: 'roses.md', block_id: 'care-tip', origin: '/ws/garden/roses.md' } })
  })

  it('au_follow: an unresolvable target returns resolved=false, not an error', async () => {
    const b = followBroker({ resolve_target: null })
    const res = (await auFollow(b).invoke!({ target: 'nope', origin: 'a.md' })) as CallableResult
    expect(res.isError).toBeUndefined()
    expect(res.content).toMatchObject({ resolved: false })
  })

  // Orientation: au_members / au_resolve_member (thin wrappers over the engine reads).
  it('au_members reads the members topology', async () => {
    const calls: FollowCall[] = []
    const members = { members: [{ repo: 'content', root: '/ws/content', scattered: false }] }
    const tool = engineTools(followBroker({ members }, calls)).find((p) => p.manifest.id === 'mcp.au_members')!
    const res = (await tool.invoke!({})) as CallableResult
    expect(calls[0]).toEqual({ op: 'members', args: {} })
    expect(res.content).toEqual(members)
  })

  it('au_resolve_member requires a path and reads resolve_member', async () => {
    const calls: FollowCall[] = []
    const tool = engineTools(followBroker({ resolve_member: { repo: 'content', root: '/ws/content' } }, calls)).find(
      (p) => p.manifest.id === 'mcp.au_resolve_member',
    )!
    expect(((await tool.invoke!({})) as CallableResult).isError).toBe(true)
    const res = (await tool.invoke!({ path: '/ws/content/b.md' })) as CallableResult
    expect(calls.at(-1)).toEqual({ op: 'resolve_member', args: { path: '/ws/content/b.md' } })
    expect(res.content).toEqual({ repo: 'content', root: '/ws/content' })
  })

  // Type lookup: au_type (by name, optional repo) / au_subtypes (base).
  it('au_type requires a name; repo folds into the qualified name (schema 8)', async () => {
    const calls: FollowCall[] = []
    const tool = engineTools(followBroker({ type: { name: 'mcp.tool' } }, calls)).find((p) => p.manifest.id === 'mcp.au_type')!
    expect(((await tool.invoke!({})) as CallableResult).isError).toBe(true)
    await tool.invoke!({ name: 'mcp.tool' })
    expect(calls.at(-1)).toEqual({ op: 'type', args: { name: 'mcp.tool' } })
    // schema 8: the `type` read dropped its `repo` arg; repo folds into the name.
    await tool.invoke!({ name: 'mcp.tool', repo: 'au-mcp-sdk' })
    expect(calls.at(-1)).toEqual({ op: 'type', args: { name: 'mcp.tool::au-mcp-sdk' } })
    // an already-qualified `name` is not double-qualified.
    await tool.invoke!({ name: 'mcp.tool::au-mcp-sdk', repo: 'ignored' })
    expect(calls.at(-1)).toEqual({ op: 'type', args: { name: 'mcp.tool::au-mcp-sdk' } })
  })

  it('au_subtypes requires a base; the wire arg is base', async () => {
    const calls: FollowCall[] = []
    const tool = engineTools(followBroker({ subtypes: { subtypes: [] } }, calls)).find((p) => p.manifest.id === 'mcp.au_subtypes')!
    expect(((await tool.invoke!({})) as CallableResult).isError).toBe(true)
    await tool.invoke!({ base: 'mcp.tool' })
    expect(calls.at(-1)).toEqual({ op: 'subtypes', args: { base: 'mcp.tool' } })
  })

  // Write path: au_validate (dry-run) / au_candidates.
  it('au_validate requires typeName and value; the wire arg is type_name', async () => {
    const calls: FollowCall[] = []
    const tool = engineTools(followBroker({ validate_value: [] }, calls)).find((p) => p.manifest.id === 'mcp.au_validate')!
    expect(((await tool.invoke!({ value: {} })) as CallableResult).isError).toBe(true) // no typeName
    expect(((await tool.invoke!({ typeName: 'mcp.tool' })) as CallableResult).isError).toBe(true) // no value
    const value = { type: 'mcp.tool', file_path: 'x' } // the candidate record's own `type` claim is legit
    await tool.invoke!({ typeName: 'mcp.tool.read_file_pinned', value })
    expect(calls.at(-1)).toEqual({ op: 'validate_value', args: { type_name: 'mcp.tool.read_file_pinned', value } })
  })

  it('au_validate accepts an object, parses a JSON-object string, rejects other strings (P1-A2)', async () => {
    const calls: FollowCall[] = []
    const tool = engineTools(followBroker({ validate_value: [] }, calls)).find((p) => p.manifest.id === 'mcp.au_validate')!
    // an OBJECT passes straight through (what the engine wants).
    await tool.invoke!({ typeName: 'plant', value: { 'common-name': 'Oak' } })
    expect(calls.at(-1)).toEqual({ op: 'validate_value', args: { type_name: 'plant', value: { 'common-name': 'Oak' } } })
    // a JSON-object STRING (the agent's instinct) is PARSED to an object before the read.
    await tool.invoke!({ typeName: 'plant', value: '{"common-name": "Oak"}' })
    expect(calls.at(-1)).toEqual({ op: 'validate_value', args: { type_name: 'plant', value: { 'common-name': 'Oak' } } })
    // strings that are not a JSON object get a clean error and issue NO read.
    const before = calls.length
    for (const bad of ['common-name: Oak', '"just a string"', '[1,2]', 'not json']) {
      expect(((await tool.invoke!({ typeName: 'plant', value: bad })) as CallableResult).isError).toBe(true)
    }
    expect(calls.length).toBe(before)
  })

  it('au_validate surfaces undeclared_fields per verdict (twin of diagnostics), defaulting to []', async () => {
    const calls: FollowCall[] = []
    // schema-26 addition: the engine verdict carries `undeclared_fields` (value keys not in the
    // identity's shape). The wrapper must forward it per verdict, and default to [] when absent.
    const verdicts = [
      { identity: { name: 'plant', repo: 'garden', hash: 'h' }, diagnostics: [], undeclared_fields: ['bogus', 'typo_field'] },
      { identity: { name: 'plant', repo: 'other', hash: 'h2' }, diagnostics: [] }, // no undeclared_fields on this verdict
    ]
    const tool = engineTools(followBroker({ validate_value: verdicts }, calls)).find((p) => p.manifest.id === 'mcp.au_validate')!
    const res = (await tool.invoke!({ typeName: 'plant', value: { 'common-name': 'Oak', bogus: 'x', typo_field: 1 } })) as CallableResult
    const out = res.content as { verdicts: Array<{ undeclared_fields: string[] }> }
    expect(out.verdicts[0].undeclared_fields).toEqual(['bogus', 'typo_field'])
    expect(out.verdicts[1].undeclared_fields).toEqual([]) // absent on the verdict -> [], the twin of diagnostics
  })

  it('au_candidates defaults to candidate_counts + a paged candidates SUMMARY', async () => {
    const calls: FollowCall[] = []
    const b = followBroker({ candidate_counts: { total_files: 5, files_with_candidates: 2, by_type: {} }, candidates: { candidates: [] } }, calls)
    const tool = engineTools(b).find((p) => p.manifest.id === 'mcp.au_candidates')!
    const res = (await tool.invoke!({ limit: 10 })) as CallableResult
    expect(calls.map((c) => c.op)).toEqual(['candidate_counts', 'candidates'])
    expect(calls.at(-1)).toEqual({ op: 'candidates', args: { summary: true, limit: 10, offset: 0 } })
    expect(res.content).toMatchObject({ total_files: 5, files_with_candidates: 2, candidates: [] })
  })

  it('au_instances indexes the knowledge-base-wide instances read (file+claim+closure), paged, detail:true opts into full entries', async () => {
    const calls: FollowCall[] = []
    const entries = [
      { file: 'a.md', claim: ['plant'], closure: ['plant', 'thing'], effective_values: [1, 2, 3] },
      { file: 'b.md', claim: ['note'], closure: ['note'], effective_values: [4] },
    ]
    const b = followBroker({ instances: { count: 3, aborted_at_load: false, instances: entries } }, calls)
    const tool = engineTools(b).find((p) => p.manifest.id === 'mcp.au_instances')!
    // default: INDEX only (no effective_values), paged over the resolved entries.
    const res = (await tool.invoke!({ limit: 1 })) as CallableResult
    expect(calls.at(-1)).toEqual({ op: 'instances', args: {} })
    expect(res.content).toMatchObject({ count: 3, resolved: 2, detail: false, truncated: true, next_offset: 1 })
    const idx = (res.content as { instances: unknown[] }).instances
    expect(idx).toEqual([{ file: 'a.md', claim: ['plant'], closure: ['plant', 'thing'] }]) // no heavy fields
    // detail:true returns the full entry.
    const full = (await tool.invoke!({ detail: true })) as CallableResult
    expect((full.content as { instances: Record<string, unknown>[] }).instances[0].effective_values).toEqual([1, 2, 3])
  })

  it('au_list_imports + au_top_level_dirs are argless passthroughs', async () => {
    const calls: FollowCall[] = []
    const b = followBroker({ imports: [{ importer: 'r', name: 't', owner: 'p', hash: 'h' }], top_level_dirs: [{ name: 'g', path: '/g' }] }, calls)
    const li = engineTools(b).find((p) => p.manifest.id === 'mcp.au_list_imports')!
    const tlg = engineTools(b).find((p) => p.manifest.id === 'mcp.au_top_level_dirs')!
    expect((((await li.invoke!({})) as CallableResult).content as unknown[])).toHaveLength(1)
    expect((((await tlg.invoke!({})) as CallableResult).content as unknown[])).toHaveLength(1)
    expect(calls.map((c) => c.op)).toEqual(['imports', 'top_level_dirs'])
    expect(calls.every((c) => Object.keys(c.args).length === 0)).toBe(true)
  })

  it('au_overview folds in graph_shape health and forwards repo/scope to BOTH reads', async () => {
    const calls: FollowCall[] = []
    const overview = { members: [], top_level_dirs: [], type_counts: { total: 0, by_repo: {} }, diagnostic_counts: { total: 0 }, hubs: [], repo: null, scope: 'own' }
    const graph_shape = { repo: null, scope: 'own', node_count: 12, edge_count: 8, edges_structural: 5, edges_navigational: 3, components: 3, largest_component: 7, orphans: { no_inbound: 4, isolated: 1 }, degree: { in: [], out: [] }, density: 0.67 }
    const b = followBroker({ overview, graph_shape }, calls)
    const t = engineTools(b).find((p) => p.manifest.id === 'mcp.au_overview')!
    // argless -> own-scoped; the aggregate map rides through with graph_shape FOLDED IN under its key.
    const res = (await t.invoke!({})) as CallableResult
    expect(res.content).toEqual({ ...overview, graph_shape })
    // both reads fired, own-scoped; graph_shape with orphan_paths OFF (cheap counts, no path list).
    expect(calls).toEqual([{ op: 'overview', args: {} }, { op: 'graph_shape', args: { orphan_paths: false } }])
    // repo + scope forwarded verbatim to BOTH reads (so a drill uses the same args).
    calls.length = 0
    await t.invoke!({ repo: 'au-mcp', scope: 'all' })
    expect(calls).toEqual([
      { op: 'overview', args: { repo: 'au-mcp', scope: 'all' } },
      { op: 'graph_shape', args: { repo: 'au-mcp', scope: 'all', orphan_paths: false } },
    ])
  })

  it('au_overview omits graph_shape when the engine does not serve it (best-effort, no regression)', async () => {
    const calls: FollowCall[] = []
    const overview = { members: [], top_level_dirs: [], type_counts: { total: 0, by_repo: {} }, diagnostic_counts: { total: 0 }, hubs: [], repo: null, scope: 'own' }
    // graph_shape NOT in the results map -> the broker yields a null result (old engine / unknown read).
    const b = followBroker({ overview }, calls)
    const t = engineTools(b).find((p) => p.manifest.id === 'mcp.au_overview')!
    const res = (await t.invoke!({})) as CallableResult
    // the core orientation map still returns, with NO graph_shape key (not a null one).
    expect(res.content).toEqual(overview)
    expect((res.content as Record<string, unknown>).graph_shape).toBeUndefined()
    // it still ATTEMPTED the read (best-effort, not silently skipped).
    expect(calls.map((c) => c.op)).toEqual(['overview', 'graph_shape'])
  })

  it('au_hubs passes the ranking through and forwards repo/scope/limit/offset', async () => {
    const calls: FollowCall[] = []
    const hubs = [{ path: '/ws/a.md', repo: 'r', kind: 'note', refs_structural: 3, refs_navigational: 1, refs_total: 4 }]
    const b = followBroker({ hubs }, calls)
    const t = engineTools(b).find((p) => p.manifest.id === 'mcp.au_hubs')!
    // argless -> own-scoped, engine top-N (empty args); the ranking rides through.
    expect(((await t.invoke!({})) as CallableResult).content).toEqual(hubs)
    expect(calls.at(-1)).toEqual({ op: 'hubs', args: {} })
    // all four args forwarded verbatim.
    await t.invoke!({ repo: 'au-mcp', scope: 'all', limit: 5, offset: 10 })
    expect(calls.at(-1)).toEqual({ op: 'hubs', args: { repo: 'au-mcp', scope: 'all', limit: 5, offset: 10 } })
    // absent limit/offset are not forwarded (so the engine applies its top-N default).
    await t.invoke!({ repo: 'au-mcp' })
    expect(calls.at(-1)).toEqual({ op: 'hubs', args: { repo: 'au-mcp' } })
  })

  it('au_semantic_tokens requires a path and passes it through', async () => {
    const calls: FollowCall[] = []
    const b = followBroker({ semantic_tokens: [{ kind: 'anchor', range: {}, text: 'H' }] }, calls)
    const tool = engineTools(b).find((p) => p.manifest.id === 'mcp.au_semantic_tokens')!
    expect(((await tool.invoke!({})) as CallableResult).isError).toBe(true) // path required
    const res = (await tool.invoke!({ path: '/ws/a.md' })) as CallableResult
    expect(calls.at(-1)).toEqual({ op: 'semantic_tokens', args: { path: '/ws/a.md' } })
    expect((res.content as unknown[])).toHaveLength(1)
  })

  it('au_types defaults to a paged SUMMARY (type_counts + summary types), reports truncation', async () => {
    const calls: FollowCall[] = []
    const b = followBroker({ type_counts: { total: 3, by_repo: { r: 3 } }, types: [{ name: 'a' }, { name: 'b' }] }, calls)
    const tool = engineTools(b).find((p) => p.manifest.id === 'mcp.au_types')!
    const res = (await tool.invoke!({ limit: 2 })) as CallableResult
    expect(calls.map((c) => c.op)).toEqual(['type_counts', 'types'])
    expect(calls.at(-1)).toEqual({ op: 'types', args: { summary: true, limit: 2, offset: 0 } })
    expect(res.content).toMatchObject({ total: 3, detail: false, truncated: true, next_offset: 2 })
  })

  it('au_types detail:true pages FULL defs (no summary flag), repo scopes both reads', async () => {
    const calls: FollowCall[] = []
    const b = followBroker({ type_counts: { total: 1 }, types: [{ name: 'a', fields: [] }] }, calls)
    const tool = engineTools(b).find((p) => p.manifest.id === 'mcp.au_types')!
    await tool.invoke!({ detail: true, repo: 'au-mcp' })
    expect(calls[0]).toEqual({ op: 'type_counts', args: { repo: 'au-mcp' } })
    expect(calls.at(-1)).toEqual({ op: 'types', args: { limit: 50, offset: 0, repo: 'au-mcp' } })
  })
})
