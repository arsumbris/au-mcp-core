// au_instances_of governor (P6-O7).
//
// The engine's `instances_of` returns every matching instance WITH its full `fields`
// (the frontmatter map). For an append-only type like `session-log` (whose instances
// are unboundedly-growing event streams) that overflows: a dogfood agent asked "which
// session-logs exist?" and got every event of every session (171k chars).
//
// So the agent-facing tool DEFAULTS to an INDEX (path + claim + the schema-6 identity fields
// name/hash/type_owners/claimed/inherited — no `fields`) and PAGES it; `resolve: true` opts back
// into the full `fields`. This is the agent-context-budget call (ours; the engine surfaces
// facts) — the same shaping F2 did for au_diagnostics. The index/window shaping STAYS ours.
//
// Schema 6 reshaped the engine's `instances_of` (au-engine-sdk notification 260704235132):
// rows are now match records, one per (instance, matched identity). `closure` is gone; the
// identity is `hash` (closure-hash, hex) + `name`, with `type_owners` (defining repos), `claimed`
// (direct `type:` claim) and `inherited` (a transitive ancestor). A bare-type query can return
// several records for one instance under distinct hashes, so `count` is match-record count.
//
// STANDIN [[message - 260622231009 - source-side index form of instances_of, no full fields::au-engine]]:
// this windows AFTER the engine sends the full payload (the daemon still receives the
// 171k), so it bounds the AGENT's result, NOT the engine->daemon wire. The generic
// "list instances without materializing their fields, paged source-side" belongs on the
// engine read. SWAP when the engine ships an index/lightweight `instances_of` (or
// `include_fields:false` + limit/offset): read the index source-side, keep `resolve:true`
// as the opt-in to the full read. The F2 (diagnostics) arc.

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

const clampLimit = (n?: number): number =>
  n === undefined || !Number.isFinite(n) || n < 1 ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, Math.floor(n))
const clampOffset = (n?: number): number => (n === undefined || !Number.isFinite(n) ? 0 : Math.max(0, Math.floor(n)))

/** One schema-6 `instances_of` match record (the parts we surface). */
export interface InstanceRow {
  path?: unknown
  claim?: unknown
  /** The matched type's name. */
  name?: unknown
  /** The matched type's closure-hash identity, hex. Equal hashes are the same type. */
  hash?: unknown
  /** The repos defining this exact identity (several when repos share a byte-identical def). schema-17: `type_owners` (was `owners`). */
  type_owners?: unknown
  /** True when the instance directly claims this identity in its `type:`. */
  claimed?: unknown
  /** True when this identity is a transitive ancestor of a type the instance claims. */
  inherited?: unknown
  /** schema-13: where the instance lives — `"file"` | `"nested"` (an inline record) | `"meta"`. */
  origin?: unknown
  /** schema-13: for a nested/meta match, how to reach it within `path` — `{ kind, field_path, block_id }`. `null` for a file match. */
  locator?: unknown
  /** schema-13: the instance's source byte range within `path`. */
  span?: unknown
  /**
   * The instance's own `#:` head docstring (the value-surface twin of a type-def's `doc`).
   * Advisory, never validated. Absent when the instance carries none. schema-25 (additive).
   */
  doc?: unknown
  /**
   * Field name to that field's `#:` docstring, documented fields only. The value-surface twin
   * of `WireField.doc`. Absent when no field is documented. schema-25 (additive).
   */
  field_docs?: unknown
  fields?: unknown
}

export interface GovernInstancesOpts {
  /** Include each instance's full `fields` (the heavy form). Default false (index only). */
  resolve?: boolean
  limit?: number
  offset?: number
}

/** The identity fields carried in every index row (schema-6; `closure` was removed). */
function identity(r: InstanceRow) {
  return {
    path: r.path,
    claim: r.claim,
    name: r.name,
    hash: r.hash,
    type_owners: r.type_owners,
    claimed: r.claimed,
    inherited: r.inherited,
    // schema-13: keep the origin tag + navigation locator in the light index, so nested inline
    // records (several to a file) are distinguishable and reachable — not collapsed to one path.
    ...(r.origin !== undefined ? { origin: r.origin } : {}),
    ...(r.locator != null ? { locator: r.locator } : {}),
    // schema-25: the instance's own `#:` docstrings ride the LIGHT index, not the heavy `fields`
    // form — they are the instance's "intent" (a workflow step's node-comment), small and the point
    // of surfacing. Omitted when absent, mirroring the sdk's optional/omit convention.
    ...(r.doc !== undefined ? { doc: r.doc } : {}),
    ...(r.field_docs !== undefined ? { field_docs: r.field_docs } : {}),
  }
}

/**
 * One knowledge-base-wide `instances` read entry (the parts we index). The engine returns the
 * FULL introspection per entry (effective_shape, collisions, effective_values, body_events,
 * …) — heavier still than `instances_of`'s `fields`, so the whole-knowledge-base read overflows even
 * harder. We index by { file, claim, closure } and page; `detail:true` returns the full entry.
 */
export interface AllInstancesEntry {
  file?: unknown
  claim?: unknown
  /** The type names the instance conforms to (claim + transitive ancestors), bare. */
  closure?: unknown
  [k: string]: unknown
}

export interface GovernAllInstancesOpts {
  /** Return each entry's FULL introspection (the heavy form). Default false (index only). */
  detail?: boolean
  limit?: number
  offset?: number
}

/** The identity fields carried in every all-instances index row. */
function allInstancesIdentity(e: AllInstancesEntry) {
  return { file: e.file, claim: e.claim, closure: e.closure }
}

/**
 * Shape the knowledge-base-wide `instances` read ({ count, aborted_at_load, entries }) into a bounded,
 * index-by-default result. Paging windows the `entries` (the RESOLVED set); `count` is the
 * engine's parsed-instance count verbatim (can exceed `entries.length` when a broken vocabulary
 * left some unresolved — `aborted_at_load` flags that case). This windows AFTER the engine sends
 * the full payload (the same STANDIN caveat as governInstances: the daemon still receives it all;
 * the source-side index/paging belongs on the engine read).
 */
export function governAllInstances(
  result: { count?: unknown; aborted_at_load?: unknown; instances?: unknown } | null,
  opts: GovernAllInstancesOpts = {},
) {
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  const detail = opts.detail === true
  const entries = Array.isArray(result?.instances) ? (result!.instances as AllInstancesEntry[]) : []
  const window = entries.slice(offset, offset + limit)
  const instances = window.map((e) => (detail ? e : allInstancesIdentity(e)))
  const truncated = offset + window.length < entries.length
  return {
    count: typeof result?.count === 'number' ? result.count : entries.length,
    resolved: entries.length,
    ...(result?.aborted_at_load ? { aborted_at_load: true } : {}),
    detail,
    instances,
    offset,
    limit,
    truncated,
    ...(truncated ? { next_offset: offset + limit } : {}),
  }
}

/** Shape the full `instances_of` match records into a bounded, index-by-default result. */
export function governInstances(rows: InstanceRow[], opts: GovernInstancesOpts = {}) {
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  const resolve = opts.resolve === true
  const window = rows.slice(offset, offset + limit)
  const instances = window.map((r) => (resolve ? { ...identity(r), fields: r.fields } : identity(r)))
  const truncated = offset + window.length < rows.length
  return {
    count: rows.length,
    resolve,
    instances,
    offset,
    limit,
    truncated,
    ...(truncated ? { next_offset: offset + limit } : {}),
  }
}
