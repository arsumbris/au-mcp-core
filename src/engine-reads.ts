// First-party engine-read callable plugins (mcp.au_*), ported from old au-mcp
// `src/tools/engine.ts`. Each reads the typed knowledge base THROUGH the daemon's broker
// (P7) — never its own socket. ALWAYS registered (not gated on engine-availability
// at daemon startup): advertisement must not depend on whether the engine socket
// happened to exist the instant the daemon started — that one-time check made a
// startup race silently hide every au_* tool for the daemon's whole life (P7-O4).
// Each read fails GRACEFULLY at call time when the engine is unreachable.

import { basename, relative } from 'node:path'
import type { Plugin, CallableResult } from '@arsumbris/au-mcp-sdk'
import { parseWikilinkInner } from '@arsumbris/au-engine-sdk/wikilink'
import type { PluginBroker, EngineFrame } from '@arsumbris/au-mcp-sdk'
import { ok, fail, optString, optNumber, optBool, ENGINE_DOWN_HINT, engineDown } from './result.ts'
import { governInstances, governAllInstances } from './instances.ts'

/**
 * A path's engine classification via `resolve_target.kind` (P6-O10), or null. Lets
 * au_typed distinguish a `type-def` from a plain note (`unclassified`) — both of which
 * the `resolved` read returns null for. `resolve_target`'s `target` is REPO-RELATIVE
 * (an absolute path resolves to null), so relativize against the workspace (the entry root).
 */
async function resolveKind(broker: PluginBroker, workspace: string | undefined, absPath: string): Promise<string | null> {
  if (!workspace || !broker.available()) return null
  try {
    const frame = await broker.read('resolve_target', { target: relative(workspace, absPath) })
    if (frame.ready === false || frame.type === 'error') return null
    const result = frame.result as { kind?: unknown } | undefined
    return typeof result?.kind === 'string' ? result.kind : null
  } catch {
    return null
  }
}

// au_diagnostics paging bounds (the agent-context-budget call is ours; the engine
// surfaces facts). A 0/negative/non-finite limit falls to the default.
const DEFAULT_DIAG_LIMIT = 50
const MAX_DIAG_LIMIT = 500
const clampLimit = (n?: number): number =>
  n === undefined || !Number.isFinite(n) || n < 1 ? DEFAULT_DIAG_LIMIT : Math.min(MAX_DIAG_LIMIT, Math.floor(n))
const clampOffset = (n?: number): number => (n === undefined || !Number.isFinite(n) ? 0 : Math.max(0, Math.floor(n)))

// Every tool here is an ENGINE READ (routes through `broker.read`), so its declared access is
// `read` — surfaced on the manifest for MediationContext.accessOf. None mutate.
function callable(id: string, name: string, invoke: (input: unknown) => Promise<CallableResult>): Plugin {
  return { manifest: { id, name, kind: 'tool', contractVersion: 0, access: 'read' }, invoke }
}

/** Run one engine read through the broker and unwrap the response frame. */
async function readTool(broker: PluginBroker, op: string, args: Record<string, unknown>): Promise<CallableResult> {
  try {
    const frame = await broker.read(op, args)
    if (frame.ready === false) return fail('engine not ready (ref still deriving)')
    if (frame.type === 'error') return fail(JSON.stringify(frame, null, 2))
    // A legitimate null result (an absent atom / unresolved path) returns a clean null,
    // NOT the raw wire frame. `?? frame` leaked `{type,ready,version,result:null,...}` to
    // the agent (dogfood: au_type_system{name:"sealed"} surfaced the envelope). P1-A4.
    return ok(frame.result ?? null)
  } catch (e) {
    return fail(engineDown(e))
  }
}

// The type-system reference now lives as typed `reference-atom` instances in the mounted
// au-mcp-type-knowledge package (synced from the standalone au-type-system spec repo,
// type-system/*.md incl. the diagnostic-codes catalog), NOT the engine's dropped compiled-in `type_system_reference`
// read. See [[decision - 2607031829 ...]] / [[decision - 2607031934 ...]]. au_type_system
// reads those instances over the generic read surface: `instances_of {type: reference-atom::...}`
// for the set, `content {path}` for each atom's source text.
//
// `reference-atom` is a POSITIVE, OWNED identity (decision 2607052009): we query it directly,
// `::au-mcp-type-knowledge`-qualified, instead of querying the `doc` BASE and filtering out the
// sibling `type-design-guide` subtype. The qualifier scopes to the one identity that package
// owns, so a foreign repo's same-named type never leaks in; and asking for `reference-atom`
// (not `doc`) means the guides — a different subtype — are simply not in the result. No filter.
const TS_MOC_NAME = 'moc - type system'
const TS_DIAGNOSTICS_NAME = 'spec - diagnostic codes'
// The owned identity the reference atoms claim. `::repo`-qualified so `instances_of` scopes to
// au-mcp-type-knowledge's `reference-atom`, not any same-named type another mounted repo defines.
const REFERENCE_ATOM_TYPE = 'reference-atom::au-mcp-type-knowledge'

type DocAtom = { path: string; name: string }

/** basename stem of a repo path: strip the dir and the trailing `.md`. */
function atomName(p: string): string {
  const base = p.split('/').pop() ?? p
  return base.replace(/\.md$/i, '')
}

/** Strip a leading `---\n…\n---` frontmatter block (the injected `type: reference-atom`). */
function stripFrontmatter(text: string): string {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/)
  return m ? text.slice(m[0].length).replace(/^\n+/, '') : text
}

/**
 * The mounted reference atoms: the `reference-atom` instances au-mcp-type-knowledge owns. The
 * `::repo`-qualified query scopes to that one identity, so the guides (a sibling `doc` subtype)
 * and any foreign same-named type are excluded at the engine — no post-filter needed. Deduped by
 * path (schema 6 returns one match record per (instance, identity); a single owned identity yields
 * one per atom, but dedupe stays robust to a byte-identical vendored copy sharing the hash).
 * Returns null on a down/erroring engine, [] when the package is not mounted (type not in scope).
 */
async function listReferenceAtoms(broker: PluginBroker): Promise<DocAtom[] | null> {
  let frame: Awaited<ReturnType<PluginBroker['read']>>
  try {
    frame = await broker.read('instances_of', { type: REFERENCE_ATOM_TYPE })
  } catch {
    return null
  }
  if (frame.ready === false) return null
  if (frame.type === 'error') return [] // unknown type reference-atom → package not mounted
  const rows = Array.isArray(frame.result) ? frame.result : []
  const seen = new Set<string>()
  const atoms: DocAtom[] = []
  for (const r of rows) {
    const path = (r as { path?: unknown })?.path
    if (typeof path !== 'string' || seen.has(path)) continue
    seen.add(path)
    atoms.push({ path, name: atomName(path) })
  }
  return atoms
}

/** One atom's source text (frontmatter stripped), or null if unreadable. */
async function readAtomText(broker: PluginBroker, path: string): Promise<string | null> {
  const frame = await broker.read('content', { path })
  if (frame.ready === false || frame.type === 'error') return null
  const c = frame.result as { text?: unknown } | null
  return c && typeof c.text === 'string' ? stripFrontmatter(c.text) : null
}

const NOT_MOUNTED =
  'the type-system reference package (au-mcp-type-knowledge) is not mounted in this workspace. ' +
  'Mount it as a dependency to use au_type_system (it serves the typed `reference-atom` instances).'

/** `au_type_system` over the mounted `doc` atoms: no-arg map / by-name atom / full bundle. */
async function readTypeSystem(broker: PluginBroker, input: unknown): Promise<CallableResult> {
  const atoms = await listReferenceAtoms(broker)
  if (atoms === null) return fail(`engine not ready or unreachable. ${ENGINE_DOWN_HINT}`)
  if (atoms.length === 0) return fail(NOT_MOUNTED)
  const byName = new Map(atoms.map((a) => [a.name, a.path]))

  // full:true → the whole conceptual bundle: moc first, then every atom EXCEPT the moc and the
  // diagnostic-codes catalog (reference-only, ~2600 lines — looked up per-name when an error
  // fires; inlining it overflows the tool-result cap, P6-O7). Assembled from per-atom reads.
  if (optBool(input, 'full') === true) {
    const parts: string[] = []
    const mocPath = byName.get(TS_MOC_NAME)
    if (mocPath) {
      const moc = await readAtomText(broker, mocPath)
      if (moc) parts.push(moc)
    }
    for (const a of atoms) {
      if (a.name === TS_MOC_NAME || a.name === TS_DIAGNOSTICS_NAME) continue
      const text = await readAtomText(broker, a.path)
      if (text) parts.push(`\n\n---- [${a.name}]\n${text}`)
    }
    if (parts.length === 0) return fail('type-system reference is empty (no readable atoms)')
    return ok(parts.join('\n'))
  }

  // name → one atom (any doc atom, incl. the diagnostic-codes catalog).
  const name = optString(input, 'name')
  if (name) {
    const path = byName.get(name)
    if (!path) return fail(`no type-system atom named "${name}". Call au_type_system with no argument for the map of atom names.`)
    const text = await readAtomText(broker, path)
    return text === null ? fail(`could not read atom "${name}"`) : ok(text)
  }

  // no-arg → the map: the moc (its reading-order + per-atom TLDRs) + every atom name.
  const mocPath = byName.get(TS_MOC_NAME)
  const moc = mocPath ? await readAtomText(broker, mocPath) : null
  const specs = atoms.map((a) => a.name).sort((x, y) => x.localeCompare(y))
  return ok({ moc, specs })
}

/** A span carries byte offsets plus an optional 1-based line/col range (WireSpan). */
type SpanLike = { start?: number; end?: number; line_col?: { start: { line: number }; end: { line: number } } }

/**
 * Parse a wikilink target into au_follow's read args, through the SDK's canonical
 * `parseWikilinkInner` (the exact grammar the engine emits — never a hand-roll, so
 * `^^`, fragment ordering, and `::repo@commit` all parse correctly).
 * - `::repo` / `@commit` stay EMBEDDED in `target` (an opaque passthrough the engine honors).
 * - `#anchor` and `^block-id` split into their own args.
 * - a `^^id` block-referent yields the BARE id + `referent: true` (following lands on the same
 *   block either way; the resolve read takes the bare id). A bare `^id` is `referent: false`.
 * - a `:field` attribution is not a navigation target and is dropped.
 * Surrounding `[[ ]]` are stripped if the agent passed them. A malformed link returns its
 * parse error instead of silently mis-resolving.
 */
function parseFollowTarget(
  raw: string,
): { ok: true; target: string; anchor?: string; blockId?: string; referent?: boolean } | { ok: false; error: string } {
  let inner = raw.trim()
  if (inner.startsWith('[[') && inner.endsWith(']]')) inner = inner.slice(2, -2).trim()
  const parsed = parseWikilinkInner(inner)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const { target, repo, commit, anchor, block_id } = parsed.parts
  // Re-embed the resolution-scope qualifiers the engine honors on the target string:
  // `::repo`, `::repo@commit`, or the this-repo pin `::@commit` (repo null, commit set).
  const scope = repo === null && commit === null ? '' : `::${repo ?? ''}${commit !== null ? `@${commit}` : ''}`
  return {
    ok: true,
    target: `${target}${scope}`,
    anchor: anchor ?? undefined,
    blockId: block_id?.id,
    referent: block_id?.referent,
  }
}

/** The target lines of a resolved block/heading, for the au_follow peek. line_col is 1-based. */
function lineSnippet(content: string, span: SpanLike): string | undefined {
  const lc = span.line_col
  if (!lc) return undefined
  const lines = content.split('\n')
  const from = Math.max(0, lc.start.line - 1)
  const to = Math.min(lines.length, Math.max(lc.end.line, lc.start.line))
  const picked = lines.slice(from, to).join('\n').trim()
  return picked || undefined
}

/**
 * The engine-read tools. ALWAYS registered — advertisement is decoupled from whether
 * the engine was reachable at daemon startup (the old `if (!broker.available()) return []`
 * gate made a startup race permanently hide every au_* tool — P7-O4). Each read fails
 * gracefully at call time (readTool + the inline callers catch a down engine).
 */
export function engineTools(broker: PluginBroker, workspace?: string): Plugin[] {
  return [
    // Source-side summary + paging + counts (engine shipped it; closes the au_types overflow ask
    // 260704103430). DEFAULT to a paged SUMMARY (name/hash/parents/sealed/doc — light), so the
    // whole-workspace browse never overflows; `detail:true` pages the FULL WireTypeDefs; `au_type
    // {name}` fetches one. The total (type_counts) + truncated + next_offset tell the agent how to
    // page + that there is more — the discoverability the harvest (plan 2607011757) asked for.
    callable(
      'mcp.au_types',
      'Engine: type-defs — a paged SUMMARY by default; detail:true for full defs, or au_type {name} for one',
      async (input) => {
        const repo = optString(input, 'repo')
        const detail = optBool(input, 'detail') === true
        const limit = clampLimit(optNumber(input, 'limit'))
        const offset = clampOffset(optNumber(input, 'offset'))
        const scope = repo ? { repo } : {}
        try {
          const countsFrame = await broker.read('type_counts', scope)
          if (countsFrame.ready === false) return fail('engine not ready (ref still deriving)')
          if (countsFrame.type === 'error') return fail(JSON.stringify(countsFrame, null, 2))
          const pageFrame = await broker.read('types', { ...(detail ? {} : { summary: true }), limit, offset, ...scope })
          if (pageFrame.ready === false) return fail('engine not ready (ref still deriving)')
          if (pageFrame.type === 'error') return fail(JSON.stringify(pageFrame, null, 2))
          const page = Array.isArray(pageFrame.result) ? pageFrame.result : []
          const counts = countsFrame.result as { total?: number; by_repo?: Record<string, number> } | null
          const total = typeof counts?.total === 'number' ? counts.total : page.length
          const truncated = offset + page.length < total
          return ok({
            total,
            ...(counts?.by_repo ? { by_repo: counts.by_repo } : {}),
            detail,
            types: page,
            offset,
            limit,
            truncated,
            ...(truncated ? { next_offset: offset + limit } : {}),
          })
        } catch (e) {
          return fail(engineDown(e))
        }
      },
    ),

    // Workspace-wide cross-repo parent/child forest ({ roots, nodes }, owner-annotated),
    // the agent-friendly tree form for the schema-induction loop (engine `type_tree` read,
    // wire schema 13; adopt-message 260625105214). Argless = the whole workspace.
    callable('mcp.au_type_tree', 'Engine: the type tree (cross-repo parent/child forest)', () =>
      readTool(broker, 'type_tree', {}),
    ),

    callable('mcp.au_type_system', 'Type-system reference (typed doc atoms)', (input) => readTypeSystem(broker, input)),

    // Governed (P6-O7): the engine's instances_of returns full `fields` per instance,
    // which overflows for append-only types (session-log: 171k). Default to an INDEX
    // (path+claim+the schema-6 identity: name/hash/owners/claimed/inherited) + paging;
    // `resolve:true` opts into full fields.
    callable(
      'mcp.au_instances_of',
      'Engine: an INDEX of a type\'s instances (path+claim+identity), paged; resolve:true for full fields',
      async (input) => {
        // Agent-facing param is `ofType` (`type` is a reserved field name); the wire arg is `type`.
        const type = optString(input, 'ofType')
        if (!type) return fail("'ofType' is required (the type name to list instances of)")
        // schema-13 opt-out: no `origins` = ALL origins (file + nested inline records + meta).
        // Narrow with e.g. ["file"] to skip nested records, or ["nested"] for records only.
        const originsRaw = (input as { origins?: unknown }).origins
        const origins =
          Array.isArray(originsRaw) && originsRaw.length > 0 && originsRaw.every((o) => typeof o === 'string')
            ? (originsRaw as string[])
            : undefined
        try {
          const frame = await broker.read('instances_of', { type, ...(origins ? { origins } : {}) })
          if (frame.ready === false) return fail('engine not ready (ref still deriving)')
          if (frame.type === 'error') return fail(JSON.stringify(frame, null, 2))
          const rows = Array.isArray(frame.result) ? frame.result : []
          return ok(
            governInstances(rows, {
              resolve: optBool(input, 'resolve'),
              limit: optNumber(input, 'limit'),
              offset: optNumber(input, 'offset'),
            }),
          )
        } catch (e) {
          return fail(engineDown(e))
        }
      },
    ),

    // Governed like au_instances_of (P6-O7): the knowledge-base-wide `instances` read returns the FULL
    // per-instance introspection (effective_shape, collisions, effective_values, body_events, …),
    // which overflows even harder than instances_of's `fields`. Default to an INDEX
    // (file+claim+closure) + paging; `detail:true` opts into the full entries. `count` is the
    // engine's parsed-instance count, `resolved` the count of resolved entries we page over.
    callable(
      'mcp.au_instances',
      'Engine: an INDEX of every knowledge base instance (file+claim+closure), paged; detail:true for full introspection',
      async (input) => {
        try {
          const frame = await broker.read('instances', {})
          if (frame.ready === false) return fail('engine not ready (ref still deriving)')
          if (frame.type === 'error') return fail(JSON.stringify(frame, null, 2))
          return ok(
            governAllInstances(frame.result as Parameters<typeof governAllInstances>[0], {
              detail: optBool(input, 'detail'),
              limit: optNumber(input, 'limit'),
              offset: optNumber(input, 'offset'),
            }),
          )
        } catch (e) {
          return fail(engineDown(e))
        }
      },
    ),

    // Discoverability (5e/F3a): a lightweight "is this typed, and of what type?" probe so
    // the agent doesn't have to infer typed-ness from au_resolved returning null. Distills
    // the `resolved` read (non-null carries the type claim) + `resolve_target.kind` (P6-O10:
    // distinguishes a TYPE-DEF from a plain note, both of which `resolved` returns null for).
    // NOT a standin: the engine already surfaces these facts; this shapes them for the agent.
    callable('mcp.au_typed', 'Engine: whether a path is a typed instance, a type-def, or a plain note', async (input) => {
      const path = optString(input, 'path')
      if (!path) return fail("'path' is required")
      try {
        const frame = await broker.read('instance', { path })
        if (frame.ready === false) return fail('engine not ready (ref still deriving)')
        if (frame.type === 'error') return fail(JSON.stringify(frame, null, 2))
        const r = frame.result as { resolved?: boolean; claim?: string[]; closure?: string[] } | null | undefined
        if (r != null) {
          return ok({ path, typed: true, kind: 'instance', claim: r.claim ?? [], resolves: r.resolved ?? false, closure: r.closure ?? [] })
        }
        // Not a parsed instance: `type-def` | `unclassified` (plain note) | repo-registry | workspace.
        const kind = await resolveKind(broker, workspace, path)
        return ok({ path, typed: false, ...(kind ? { kind } : {}) })
      } catch (e) {
        return fail(engineDown(e))
      }
    }),

    callable('mcp.au_resolved', 'Engine: resolved view of an instance', (input) => {
      const path = optString(input, 'path')
      if (!path) return Promise.resolve(fail("'path' is required"))
      return readTool(broker, 'instance', { path })
    }),

    callable('mcp.au_frontmatter', 'Engine: parsed frontmatter', (input) => {
      const path = optString(input, 'path')
      if (!path) return Promise.resolve(fail("'path' is required"))
      return readTool(broker, 'frontmatter', { path })
    }),

    // A file's typed, reference-aware highlight-token stream (what a generic grammar cannot
    // produce): wikilinks (resolved/broken), typed field values + shapes, type claims, block
    // ids, anchors. Per-file (bounded by one file), so a passthrough. null for a non-held file.
    callable('mcp.au_semantic_tokens', 'Engine: a file\'s semantic highlight tokens', (input) => {
      const path = optString(input, 'path')
      if (!path) return Promise.resolve(fail("'path' is required"))
      return readTool(broker, 'semantic_tokens', { path })
    }),

    callable('mcp.au_children', 'Engine: directory entries', (input) => {
      const dir = optString(input, 'dir')
      if (!dir) return Promise.resolve(fail("'dir' is required"))
      return readTool(broker, 'dir_entries', { dir })
    }),

    callable('mcp.au_references', 'Engine: outgoing references and backlinks', (input) => {
      const path = optString(input, 'path')
      const which = optString(input, 'which')
      if (!path) return Promise.resolve(fail("'path' is required"))
      if (which !== 'out' && which !== 'in') return Promise.resolve(fail("'which' must be 'out' or 'in'"))
      return readTool(broker, which === 'out' ? 'references_out' : 'references_in', { path })
    }),

    // The three LISTING duals of the resolve verbs — "what CAN be addressed", one per
    // inhabitable wikilink fragment position (decision 2607281848). A resolve verb answers
    // whether ONE address resolves; these answer what there is to address, which is what an
    // agent AUTHORING a link needs.
    //
    // NULL IS NOT EMPTY on anchors/block_ids: an unresolved `target` answers null, a resolved
    // file carrying none answers []. `readTool` already returns a clean null (P1-A4), so the
    // distinction rides through untouched — an agent must not read "no such file" as "no headings".

    // Headings in a target, serving the `#anchor` position.
    callable('mcp.au_anchors', 'Engine: every heading in a target (the #anchor listing)', (input) => {
      const target = optString(input, 'target')
      const origin = optString(input, 'origin')
      if (!target) return Promise.resolve(fail("'target' is required (the wikilink target whose headings to list)"))
      return readTool(broker, 'anchors', { target, ...(origin !== undefined && { origin }) })
    }),

    // Addressable ids in a target, serving the `^block_id` position. Closes the catalog hole:
    // au_assign_block_id MINTS an id and au_follow resolves one, but nothing LISTED them, so an
    // agent authoring `[[target^id]]` had to already know the id or mint a new one.
    callable('mcp.au_block_ids', 'Engine: every addressable block id in a target (the ^id listing)', (input) => {
      const target = optString(input, 'target')
      const origin = optString(input, 'origin')
      if (!target) return Promise.resolve(fail("'target' is required (the wikilink target whose block ids to list)"))
      return readTool(broker, 'block_ids', { target, ...(origin !== undefined && { origin }) })
    }),

    // The catalogued file set, serving the `[[` target position. Includes ASSETS, which no other
    // surface lists — everything else derives from PARSED files, so the unread half of a knowledge
    // base was invisible. Args are all optional; absent = the whole catalogue.
    callable('mcp.au_files', 'Engine: every catalogued file — the resolvable wikilink target set', (input) => {
      const repo = optString(input, 'repo')
      const scope = optString(input, 'scope')
      const limit = optNumber(input, 'limit')
      const offset = optNumber(input, 'offset')
      return readTool(broker, 'files', {
        ...(repo !== undefined && { repo }),
        ...(scope !== undefined && { scope }),
        ...(limit !== undefined && { limit }),
        ...(offset !== undefined && { offset }),
      })
    }),

    // Resolve ONE wikilink STRING — the AUTHORING check, not go-to-definition (decision 2607281848).
    // au_references lists links a file already has; this answers whether an address you COMPOSED resolves. The agent
    // holds a link and the file it appears in; `origin` scopes a bare target repo-local
    // and a `::repo` target cross-repo (the engine owns resolution, we never guess).
    // Dispatches by the target's own fragments: `^block-id` -> resolve_block_id,
    // else `#anchor` -> resolve_anchor, else resolve_target. See
    // [[spec - agent read surface - engine reads surfaced as tools plus the wikilink authoring loop]].
    callable('mcp.au_follow', 'Engine: follow a wikilink to its target', async (input) => {
      const rawTarget = optString(input, 'target')
      const rawOrigin = optString(input, 'origin')
      if (!rawTarget) return fail("'target' is required (the wikilink to follow, e.g. 'note', 'note::repo', 'note#Heading', 'note^blk')")
      if (!rawOrigin) return fail("'origin' is required (the file the link appears in, so a bare target resolves against its repo)")
      if (!broker.available()) return fail(`engine not available. ${ENGINE_DOWN_HINT}`)

      const parsed = parseFollowTarget(rawTarget)
      if (!parsed.ok) return fail(`invalid wikilink target ${JSON.stringify(rawTarget)}: ${parsed.error}`)
      // Local form: `[[^id]]` / `[[#head]]` with no name means the CURRENT file (the
      // origin). The resolve reads take a basename target (a full repo path resolves to
      // null), so express "this file" as the origin's basename.
      const target = parsed.target || ((parsed.blockId || parsed.anchor) ? basename(rawOrigin) : '')
      const { anchor, blockId, referent } = parsed
      if (!target) return fail(`'target' has no name to resolve: ${rawTarget}`)
      // The agent passes an ABSOLUTE origin (its read path). Pass it THROUGH: the engine's
      // resolve reads now accept an absolute origin directly — origin-scoped navigation shipped
      // ("engine ask #6" is satisfied; see [[message - 260630130801 - adopt origin-scoped navigation resolution::au-engine-sdk]]),
      // resolving a bare target repo-local against the origin's index, identical to references_out.
      // The old `relative(workspace, origin)` relativization broke navigation from any member
      // mounted OUTSIDE the workspace root — i.e. every cross-repo member (verified: an absolute
      // origin resolves, its workspace-relativized form returns null).
      const origin = rawOrigin

      let frame: EngineFrame
      if (blockId) frame = await broker.read('resolve_block_id', { target, block_id: blockId, origin })
      else if (anchor) frame = await broker.read('resolve_anchor', { target, anchor, origin })
      else frame = await broker.read('resolve_target', { target, origin })

      if (frame.ready === false) return fail('engine not ready (ref still deriving)')
      if (frame.type === 'error') return fail(JSON.stringify(frame, null, 2))
      const res = frame.result as Record<string, unknown> | null
      if (!res) return ok({ resolved: false, target: rawTarget, origin: rawOrigin })

      // Normalize the three result shapes to { path, repo?, kind, span?, snippet? }.
      // resolve_target: { path, kind, source }. resolve_block_id: { file_path, kind, span }.
      // resolve_anchor: { file_path, span } (no kind — it is a heading).
      const source = res.source as { file?: string; span?: SpanLike } | null | undefined
      let path = (res.path as string | undefined) ?? (res.file_path as string | undefined)
      let span = res.span as SpanLike | undefined
      // A type-def target inside a *.yamls bundle: `path` is the dead virtual member,
      // `source.file`/`source.span` the openable physical bundle location.
      if (source && typeof source.file === 'string') {
        path = source.file
        span = source.span ?? span
      }
      if (!path) return ok({ resolved: false, target: rawTarget, origin: rawOrigin })
      const kind = anchor && !blockId ? 'heading' : (res.kind as string | undefined)

      const out: Record<string, unknown> = { resolved: true, path }
      if (kind) out.kind = kind
      // Surface the block-referent mode when a `^`/`^^` target was followed: `^^id` (referent:true)
      // means the block's typed VALUE fills the slot; `^id` (referent:false) is a navigational jump.
      if (blockId && referent !== undefined) out.referent = referent
      if (span) out.span = span

      // Enrich (both best-effort): which member owns the target, and a peek at the
      // addressed block/heading. Absolute path — the content read takes it as-is.
      try {
        const memFrame = await broker.read('resolve_member', { path })
        const mem = memFrame.result as { repo?: unknown } | null | undefined
        if (mem && typeof mem.repo === 'string') out.repo = mem.repo
      } catch {
        /* repo is best-effort */
      }
      if (span && (blockId || anchor)) {
        try {
          const cFrame = await broker.read('content', { path })
          const c = cFrame.result as { text?: unknown } | null | undefined
          if (c && typeof c.text === 'string') {
            const snip = lineSnippet(c.text, span)
            if (snip) out.snippet = snip
          }
        } catch {
          /* snippet is best-effort */
        }
      }
      return ok(out)
    }),

    // A bounded N-hop reference-graph WALK — the multi-hop generalization of au_references
    // (one hop) and au_follow (one link). The agent seeds at a path and gets back a subgraph
    // (nodes + the edges between them), for exploring a dependency closure or a related-notes
    // ripple on demand. Same read the always-on mcp.inject hop-walk uses; surfaced here as a
    // general primitive. See [[spec - agent read surface - engine reads surfaced as tools plus the wikilink authoring loop]].
    //
    // Args pass THROUGH to the engine, which owns validation: `kinds` is REQUIRED past depth 1,
    // an unknown kind or `max_nodes: 0` rejects, and readTool surfaces that arg-validation
    // message verbatim (the error arm) rather than us re-deriving the rules. We only require
    // `path` and forward the rest when present, so the tool never disagrees with the daemon.
    callable('mcp.au_neighborhood', 'Engine: bounded reference-graph walk', (input) => {
      const path = optString(input, 'path')
      if (!path) return Promise.resolve(fail("'path' is required (the file to seed the walk at)"))

      const kindsRaw = (input as { kinds?: unknown }).kinds
      const kinds =
        Array.isArray(kindsRaw) && kindsRaw.every((k) => typeof k === 'string') ? (kindsRaw as string[]) : undefined

      const args: Record<string, unknown> = { path }
      const direction = optString(input, 'direction')
      const scope = optString(input, 'scope')
      const depth = optNumber(input, 'depth')
      const maxNodes = optNumber(input, 'max_nodes')
      const content = optBool(input, 'content')
      const body = optBool(input, 'body')
      const instance = optBool(input, 'instance')
      if (direction !== undefined) args.direction = direction
      if (depth !== undefined) args.depth = depth
      if (kinds !== undefined) args.kinds = kinds
      if (scope !== undefined) args.scope = scope
      if (maxNodes !== undefined) args.max_nodes = maxNodes
      if (content !== undefined) args.content = content
      if (body !== undefined) args.body = body
      if (instance !== undefined) args.instance = instance
      return readTool(broker, 'neighborhood', args)
    }),

    // Orientation: the workspace's declared members (name + absolute root + scattered),
    // so a cross-repo agent sees the member topology without reconstructing it.
    callable('mcp.au_members', 'Engine: workspace members', () => readTool(broker, 'members', {})),

    // Orientation: the knowledge base's top-level graphs (root subdirectories holding a catalogued
    // file), each { name, folder_path }. Argless. A "where do I start browsing?" entry point.
    callable('mcp.au_top_level_dirs', 'Engine: the knowledge base top-level directories', (input) => {
      const repo = optString(input, 'repo')
      const scope = optString(input, 'scope')
      // Argless defaults to OWN scope (schema 17); scope:"all" for the old workspace-wide answer.
      return readTool(broker, 'top_level_dirs', { ...(repo ? { repo } : {}), ...(scope ? { scope } : {}) })
    }),

    // The up-front orientation map: one cheap read aggregating members / top_level_dirs /
    // type_counts / diagnostic_counts / hubs, loaded FIRST then drilled through the individual
    // reads. Own-scoped by default (schema 17); echoes its resolved repo/scope.
    //
    // We FOLD IN the whole-graph `graph_shape` scalars under a `graph_shape` key: node/edge counts,
    // connected `components` + `largest_component`, `orphans` (no_inbound / isolated), in/out
    // `degree` histograms, `density`. This is the knowledge-HEALTH half of orientation — the "N
    // disconnected components, M orphans" signal — that nothing else on the surface carried
    // (au_diagnostics is CORRECTNESS health, au_hubs only the top-degree end). Sourced from a
    // SEPARATE `graph_shape` read (the engine's `overview` does not fold it), `orphan_paths` OFF so
    // it stays cheap counts; drill orphan paths via a dedicated call if ever surfaced. BEST-EFFORT:
    // an engine too old to serve the read just omits the field — the core map still returns. See
    // [[decision - 2608051755 - surface graph_shape health folded into au_overview, link_graph stays a host concern]].
    callable('mcp.au_overview', 'Engine: the up-front orientation map (with whole-graph health)', async (input) => {
      const repo = optString(input, 'repo')
      const scope = optString(input, 'scope')
      const scoped = { ...(repo ? { repo } : {}), ...(scope ? { scope } : {}) }
      try {
        const overviewFrame = await broker.read('overview', scoped)
        if (overviewFrame.ready === false) return fail('engine not ready (ref still deriving)')
        if (overviewFrame.type === 'error') return fail(JSON.stringify(overviewFrame, null, 2))
        const base = overviewFrame.result
        if (base == null || typeof base !== 'object') return ok(base ?? null)
        // graph_shape is additive + BEST-EFFORT: fold it in when the engine serves it, omit on any
        // failure (unknown read on an old engine, not-ready) so the orientation map never regresses.
        let graph_shape: unknown
        try {
          const shapeFrame = await broker.read('graph_shape', { ...scoped, orphan_paths: false })
          if (shapeFrame.ready !== false && shapeFrame.type !== 'error') graph_shape = shapeFrame.result ?? undefined
        } catch {
          /* best-effort: leave graph_shape unset */
        }
        return ok({ ...(base as Record<string, unknown>), ...(graph_shape !== undefined ? { graph_shape } : {}) })
      } catch (e) {
        return fail(engineDown(e))
      }
    }),

    // The hub ranking: the most-referenced files over the typed reference graph, the drill-down
    // for overview.hubs. Own-scoped by default (schema 17); limit/offset omitted = the engine's
    // top-N. Forward each arg only when supplied, so absent falls to the engine's defaults.
    callable('mcp.au_hubs', 'Engine: the most-referenced files (hub ranking)', (input) => {
      const repo = optString(input, 'repo')
      const scope = optString(input, 'scope')
      const limit = optNumber(input, 'limit')
      const offset = optNumber(input, 'offset')
      return readTool(broker, 'hubs', {
        ...(repo ? { repo } : {}),
        ...(scope ? { scope } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      })
    }),

    // Which declared member owns a path -> { repo, root }, or null. The absolute path
    // is passed as-is (abs_arg), like the content read.
    callable('mcp.au_resolve_member', 'Engine: the member owning a path', (input) => {
      const path = optString(input, 'path')
      if (!path) return Promise.resolve(fail("'path' is required"))
      return readTool(broker, 'resolve_member', { path })
    }),

    // One type-def by name (owner-resolved), instead of pulling all of au_types and
    // filtering. Optional `repo` disambiguates a borrowed copy — schema 8 folds it into the
    // NAME (`type::repo`); the `type` read no longer takes a separate `repo` arg (a qualified
    // string resolves at the proxy seam with no local split). The agent-facing param is `name`
    // (`type` is a reserved field name); it maps straight to the wire arg `name`, bare or
    // `::repo`-qualified.
    callable('mcp.au_type', 'Engine: one type-def by name', (input) => {
      const typeName = optString(input, 'name')
      if (!typeName) return Promise.resolve(fail("'name' is required (the type-def name)"))
      const repo = optString(input, 'repo')
      // Fold repo into the qualified name (schema 8), unless the agent already qualified `name`.
      const name = repo && !typeName.includes('::') ? `${typeName}::${repo}` : typeName
      return readTool(broker, 'type', { name })
    }),

    // Every type-def whose closure includes the given type — the type-level dual of
    // au_instances_of. Descend a schema tree from a base while inducing types. The agent-facing
    // param is `base` (`type` is a reserved field name); it maps straight to the wire arg `base`.
    callable('mcp.au_subtypes', 'Engine: subtypes of a base type', (input) => {
      const base = optString(input, 'base')
      if (!base) return Promise.resolve(fail("'base' is required (the base type)"))
      return readTool(broker, 'subtypes', { base })
    }),

    // The workspace's discovered cross-repo import set — one record per (importing repo,
    // imported peer identity), the fold-axis `::repo` types each repo authors. Argless.
    callable('mcp.au_list_imports', 'Engine: the workspace cross-repo import set', () =>
      readTool(broker, 'imports', {}),
    ),

    // Dry-run: validate a transient value against a named type, no disk write.
    // Returns the diagnostics array (empty = valid). The write path's "would this
    // instance be valid?" — the daemon already uses this op to gate tool input.
    callable('mcp.au_validate', 'Engine: validate a value against a type (dry-run)', async (input) => {
      // Agent-facing param is `typeName` (`type` is a reserved field name); the wire arg is `type_name`.
      const type = optString(input, 'typeName')
      if (!type) return fail("'typeName' is required (the type to validate against)")
      let value: unknown = (input as Record<string, unknown> | null)?.value
      if (value === undefined) {
        return fail("'value' is required (the candidate record as a JSON object, e.g. {\"common-name\": \"Oak\"})")
      }
      // The engine wants a MAPPING; a string scalar -> `instance-not-a-mapping`. Agents
      // reach for frontmatter-as-text (dogfood: 6 failed tries), so accept a JSON-object
      // STRING by parsing it, and reject any other string with a clear steer. P1-A2.
      if (typeof value === 'string') {
        let parsed: unknown
        try {
          parsed = JSON.parse(value)
        } catch {
          return fail("'value' is a string but not valid JSON. Pass a JSON object (a mapping), e.g. {\"common-name\": \"Oak\"}")
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return fail("'value' must be a JSON object (a mapping), not a scalar or array, e.g. {\"common-name\": \"Oak\"}")
        }
        value = parsed
      }
      const repo = optString(input, 'repo')
      try {
        const frame = await broker.read('validate_value', repo ? { type_name: type, value, repo } : { type_name: type, value })
        if (frame.ready === false) return fail('engine not ready (ref still deriving)')
        if (frame.type === 'error') return fail(JSON.stringify(frame, null, 2))
        // schema-17: MULTI-FIT verdict array, one per mounted identity of `type`. Surface each
        // fit's validity + trimmed diagnostics (drop the verbose span/related), and flag a
        // NULL identity prominently — it means the type name did not resolve at all.
        type Diag = { code?: string; severity?: string; message?: string }
        type Verdict = { identity: { name?: string; repo?: string; hash?: string } | null; diagnostics?: Diag[]; undeclared_fields?: string[] }
        const verdicts = Array.isArray(frame.result) ? (frame.result as Verdict[]) : []
        const shaped = verdicts.map((v) => {
          const diags = v.diagnostics ?? []
          return {
            identity: v.identity, // {name,repo,hash}, or null = the type name is not in the graph
            valid: !diags.some((d) => d.severity === 'error'),
            diagnostics: diags.map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
            // value keys NOT in this identity's effective shape. ADVISORY, not a diagnostic:
            // extras are LEGAL under open-world validation, but a caller can catch a typo'd
            // extra even when it is not a near-miss of a required field. Empty for a null identity.
            undeclared_fields: v.undeclared_fields ?? [],
          }
        })
        return ok({
          type,
          unresolved: shaped.some((s) => s.identity === null), // true = `type` did not resolve (unknown / owner unmounted)
          verdicts: shaped,
        })
      } catch (e) {
        return fail(engineDown(e))
      }
    }),

    // The ranked types each untyped file could claim but doesn't — type induction /
    // retrofit suggestions across the knowledge base.
    // Source-side summary + paging + counts (closes the au_candidates overflow ask 260704103430).
    // DEFAULT to a paged SUMMARY ({file, candidates[]} per scanned file) + the counts, so the
    // whole-knowledge-base scan never overflows. `files_with_candidates` tells the agent how many actually
    // have retrofit suggestions; truncated + next_offset drive paging.
    callable('mcp.au_candidates', 'Engine: candidate types untyped files could claim — a paged SUMMARY + counts', async (input) => {
      const limit = clampLimit(optNumber(input, 'limit'))
      const offset = clampOffset(optNumber(input, 'offset'))
      try {
        const countsFrame = await broker.read('candidate_counts', {})
        if (countsFrame.ready === false) return fail('engine not ready (ref still deriving)')
        if (countsFrame.type === 'error') return fail(JSON.stringify(countsFrame, null, 2))
        const pageFrame = await broker.read('candidates', { summary: true, limit, offset })
        if (pageFrame.ready === false) return fail('engine not ready (ref still deriving)')
        if (pageFrame.type === 'error') return fail(JSON.stringify(pageFrame, null, 2))
        const counts = countsFrame.result as
          | { aborted_at_load?: boolean; total_files?: number; files_with_candidates?: number; by_type?: unknown }
          | null
        const pr = pageFrame.result as { candidates?: unknown[] } | null
        const page = Array.isArray(pr?.candidates) ? pr.candidates : []
        const totalFiles = typeof counts?.total_files === 'number' ? counts.total_files : offset + page.length
        const truncated = offset + page.length < totalFiles
        return ok({
          total_files: totalFiles,
          files_with_candidates: counts?.files_with_candidates ?? 0,
          ...(counts?.aborted_at_load ? { aborted_at_load: true } : {}),
          ...(counts?.by_type ? { by_type: counts.by_type } : {}),
          candidates: page,
          offset,
          limit,
          truncated,
          ...(truncated ? { next_offset: offset + limit } : {}),
        })
      } catch (e) {
        return fail(engineDown(e))
      }
    }),
  ]
}

// Loadable-plugin adapter (plan 2608261532): extract ONE engine-read tool's invoke by id, for a
// thin per-tool `createPlugin` entry. The daemon derives the manifest from the def; the entry
// supplies only the runtime, so we reuse the `engineTools()` invoke closures verbatim.
export function engineReadInvoke(
  id: string,
  broker: PluginBroker | undefined,
  workspace?: string,
): (input: unknown) => Promise<CallableResult> {
  if (!broker) return async () => fail(engineDown(new Error('no engine reachable')))
  const tool = engineTools(broker, workspace).find((p) => p.manifest.id === id)
  if (!tool?.invoke) return async () => fail(`unknown engine-read tool: ${id}`)
  return tool.invoke as (input: unknown) => Promise<CallableResult>
}
