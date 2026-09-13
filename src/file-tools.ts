// First-party file-op callable plugins, ported from old au-mcp `src/tools/*`.
//
// read_file_pinned / write_file / edit_file / glob / grep_files / bash. Workspace-scoped
// (cwd + default search base = the daemon's workspace, not process.cwd).
//
// MUTATIONS (write_file / edit_file) route through the engine's mutation channel
// ([[decision - 2606222008 ...]]), never direct fs — the one governed write path.
// The channel does content-hash CAS (`expected_hash` on write_file; edit_file
// self-guards via exact-unique old_string). With no engine, mutations REFUSE (the
// layer is paired 1:1 with the engine; there is no unguarded fs fallback). reads +
// glob + grep stay node:fs. `bash` is a SIGNAL-CAPTURING STUB — still advertised
// (so the reach + the attempted command are traced) but it does NOT execute; it
// returns a "not available, tell us what you needed" message that turns the escape
// hatch into a consumer-driven demand probe ([[decision - 2606250955 - the cage
// bash tool becomes a signal-capturing stub]]). The path-guard floor (.claude/ +
// operations/) stays as a pre-check on writes.
//
// Tool descriptions + advertised input schemas (JSON Schema) belong to the
// MCP-server shim (Phase 5) and au-type-codegen; they are not on the manifest yet.

import { readFile, glob, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { isAbsolute, join, relative } from 'node:path'
import type { Plugin, CallableResult, FileOpTouch, FileAccess, Stamp } from '@arsumbris/au-mcp-sdk'
import type { PluginBroker, EngineFrame } from '@arsumbris/au-mcp-sdk'
import { ok, fail, optString, optNumber, optBool } from './result.ts'
import { guardWritePath } from './guard.ts'

// The provenance-style STAMPS the daemon injected into a write's input (the stamper shape). They are
// daemon-computed + daemon-injected on the invoke path, NEVER an agent-facing input field, so the
// write tool only FORWARDS them to the mutation channel. Absent on a write no stamper covered.
function optStamps(input: unknown): Stamp[] | undefined {
  if (input && typeof input === 'object') {
    const s = (input as { stamps?: unknown }).stamps
    if (Array.isArray(s) && s.length > 0) return s as Stamp[]
  }
  return undefined
}

// The daemon-injected `ensure_mixins` rider (engine schema 25), the type-claim sibling of the
// stamps list. Like `stamps` it is daemon-computed + daemon-injected on the invoke path and NEVER
// an agent-facing input field, so the write tool only FORWARDS it (with its optional strict flag)
// to the mutation channel. Absent on a write no stamper typed. Copied onto `args` verbatim; the
// broker maps the pair to the engine-sdk write options.
function forwardMixins(input: unknown, args: Record<string, unknown>): void {
  if (!input || typeof input !== 'object') return
  const m = (input as { ensure_mixins?: unknown }).ensure_mixins
  if (!Array.isArray(m) || m.length === 0) return
  args.ensure_mixins = m
  const strict = (input as { ensure_mixins_strict?: unknown }).ensure_mixins_strict
  if (typeof strict === 'boolean') args.ensure_mixins_strict = strict
}

// The daemon-injected `attribution` rider (engine schema 26): commit-metadata trailers (the caller's
// session / span). Like `stamps` it is daemon-computed + daemon-injected on the invoke path and NEVER
// an agent-facing input field, so the write tool only FORWARDS it to the mutation channel. Present on
// every governed write a stamper attributed (write / edit / delete); the broker maps it to the
// engine-sdk write options.
function optAttribution(input: unknown): unknown[] | undefined {
  if (input && typeof input === 'object') {
    const a = (input as { attribution?: unknown }).attribution
    if (Array.isArray(a) && a.length > 0) return a
  }
  return undefined
}

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_GLOB_RESULTS = 1000
const MAX_GREP_MATCHES = 500
// Default per-line truncation for `content` mode — a verbatim post is one huge line,
// so an untruncated common-term grep overflows the token cap. Callers override via max_line_length.
const DEFAULT_GREP_LINE_LEN = 300

// The bash stub's agent-facing guidance ([[decision - 2606250955 ...]]). Short +
// actionable: name the gap, do not read as a hard failure to loop on. Returned via
// `ok` (a successful call that yields guidance), not `fail`.
const BASH_STUB_MESSAGE = [
  "`bash` is not available. We are still building out the engine + au-harness tools so you can work fully through them.",
  '',
  'Please do not treat this as a hard failure. Instead, route the work through the typed gate tools:',
  '- reading state: the `au_*` engine reads (e.g. `au_typed`, `au_instances_of`, `au_diagnostics`, `au_children`).',
  '- files: `read_file_pinned`, `glob`, `grep_files`, `write_file`, `edit_file`.',
  '',
  'Then tell us, in your reply: what could you NOT do without `bash`, and what tool would you have needed so you do not have to reach for it? Your attempted command was recorded — naming the gap helps us build the missing capability.',
].join('\n')

// `access` is the tool's DECLARED engine-broker level (its least privilege). Mutators (the
// mutation-channel verbs) declare `read-write`, engine reads `read`, pure-fs / stub tools `none`
// (the default). Declared at the DEFINITION site below (the `MUTATORS`/`READERS` sets over the
// tool OBJECTS, not a downstream verb-name table), it rides the manifest so a mediator can
// classify "does this action mutate?" at decide — see MediationContext.accessOf.
function callable(id: string, name: string, invoke: (input: unknown) => Promise<CallableResult>): Plugin {
  return { manifest: { id, name, kind: 'tool', contractVersion: 0, access: 'none' }, invoke }
}

/**
 * Render a mutation-channel response frame into a callable result. `absPath` is the caller's
 * input path when it has one; for a verb with no input file path (`rename_type`, whose def-file
 * location the engine derives) pass `undefined` and the engine's `result.path` is used instead.
 */
function mutationResult(
  workspace: string,
  frame: EngineFrame,
  absPath: string | undefined,
  verb: string,
  opts?: { access?: FileAccess; from?: string },
): CallableResult {
  // A reject is an `error` frame (e.g. expected_hash mismatch, stale old_string).
  // Surfacing its message verbatim keeps the gate's voice the engine's (also P6-O9).
  if (frame.type === 'error' || frame.ready === false) {
    const msg =
      (typeof frame.message === 'string' && frame.message) ||
      (typeof frame.error === 'string' && frame.error) ||
      `${verb} failed${absPath ? ` for ${absPath}` : ''}`
    return fail(msg)
  }
  const result = frame.result as { hash?: unknown; commit?: unknown; last_live_commit?: unknown; id?: unknown; ref?: unknown; path?: unknown } | undefined
  const hash = typeof result?.hash === 'string' ? result.hash : ''
  const commit = typeof result?.commit === 'string' ? result.commit : undefined
  // The DELETE-only last-live commit (au-engine-sdk's typed `WireMutateResult.last_live_commit`,
  // the parent of the deletion commit). It becomes the touch's `priorCommit` so the tombstone
  // `target` pins the READABLE last-live version, while `commit` (the deletion commit) stays for
  // `span.commits` attribution. Absent on every non-delete verb and off-git, so it rides only a
  // delete's touch.
  const priorCommit = typeof result?.last_live_commit === 'string' ? result.last_live_commit : undefined
  // assign_block_id is the one primitive returning an engine-assigned id + its
  // `[[target^id]]` reference; the agent needs both to address the block afterwards.
  // Inert for the other verbs (they carry neither), so this stays one render path.
  const id = typeof result?.id === 'string' ? result.id : undefined
  const ref = typeof result?.ref === 'string' ? result.ref : undefined
  // The TOUCHED-FILE pin material for the trace's append-only edge (`ToolCallData.target`):
  // the repo-relative path + the mutation's commit. It rides the agent-facing result
  // because the trace `tool_call` event is built downstream on the (session-bound) observe
  // path, while the commit is known here on the (session-less) invoke path — the result is
  // the only channel between them (see FileOpTouch). `commit` is absent only when the repo
  // is not a git working tree (the engine commits none); the adapter then leaves target unset.
  // The effective touched path: the caller's input path, else the engine's authoritative
  // `result.path` (rename_type takes type names, so the moved def file comes back on the result).
  const effPath = absPath ?? (typeof result?.path === 'string' ? result.path : undefined)
  // Stamp the direction on the touch, from HERE — the one layer that knows the verb — so the
  // adapter forwards `access` instead of hardcoding it or classifying a tool name. A touch only
  // ever comes from a mutation, so the direction is `write` unless a caller says otherwise
  // (`delete`, `rename`). For a rename, `from` carries the OLD path (the name-history source).
  const touched: FileOpTouch | undefined =
    effPath !== undefined
      ? {
          path: relative(workspace, effPath),
          ...(commit ? { commit } : {}),
          ...(priorCommit ? { priorCommit } : {}),
          access: opts?.access ?? 'write',
          ...(opts?.from ? { from: relative(workspace, opts.from) } : {}),
        }
      : undefined
  // The read-view update this write reports to the kernel (session FRESHNESS): keep the writing
  // session's `readView` accurate WITHOUT a re-read. `set` carries the EXACT post-write hash the
  // session now saw (so a later stale overwrite still trips the CAS); a delete/rename voids the old
  // path's entry. The kernel applies it session-bound at the invoke site and never surfaces it.
  const access = opts?.access ?? 'write'
  const remove: string[] = []
  if (access === 'delete' && effPath !== undefined) remove.push(effPath)
  if (access === 'rename' && opts?.from !== undefined) remove.push(opts.from)
  const set = access !== 'delete' && effPath !== undefined && hash ? { path: effPath, hash } : undefined
  const readViewUpdate =
    set || remove.length > 0 ? { ...(set ? { set } : {}), ...(remove.length > 0 ? { remove } : {}) } : undefined
  return {
    ...ok({
      message: `${verb}${effPath ? ` ${effPath}` : ''}${hash ? ` (hash ${hash})` : ''}${ref ? ` -> ${ref}` : ''}`,
      ...(touched ? { touched } : {}),
      ...(id ? { id } : {}),
      ...(ref ? { ref } : {}),
    }),
    ...(readViewUpdate ? { readViewUpdate } : {}),
  }
}

/**
 * The six file primitives, scoped to `workspace`. Mutations route through `broker`'s
 * engine mutation channel; when no broker/engine is present they refuse.
 */
export function fileTools(workspace: string, broker?: PluginBroker): Plugin[] {
  const noEngine = (verb: string): CallableResult =>
    fail(`cannot ${verb}: no engine for this workspace — the gate routes reads + writes through the engine, which is not reachable`)
  const readFileTool = callable('mcp.read_file_pinned', 'Read File (pinned)', async (input) => {
    const file_path = optString(input, 'file_path')
    if (!file_path) return fail("'file_path' is required")
    if (!isAbsolute(file_path)) return fail(`file_path must be absolute, got: ${file_path}`)
    const offset = optNumber(input, 'offset')
    const limit = optNumber(input, 'limit')
    // Reads route through the engine `content` read ({ content, hash } from one
    // coherent disk read), not node:fs — the read-side of the one governed channel
    // ([[decision - 2606251052 - read_file routes through the engine content read]]).
    // Reads require the engine, like writes (the layer is paired 1:1). The absolute
    // path is passed as-is (the engine's `abs_arg` takes it directly).
    if (!broker || !broker.available()) return noEngine('read')
    let raw: string
    let anchorCommit: string | undefined
    let contentHash: string | undefined
    try {
      const frame = await broker.read('content', { path: file_path })
      if (frame.type === 'error' || frame.ready === false) {
        const msg = (typeof frame.message === 'string' && frame.message) || `cannot read ${file_path}`
        return fail(msg)
      }
      // `content` returns null (-> result null) when the file is unreadable.
      const result = frame.result as { text?: unknown; hash?: unknown; commit?: unknown } | null
      if (!result || typeof result.text !== 'string') return fail(`cannot read ${file_path}: not readable`)
      raw = result.text
      // The engine anchors the read: `commit` is the repo HEAD the working-tree
      // read was taken at, `hash` the content hash. Surfacing them lets the caller
      // pin the exact version it read as [[path::@commit]] — via a SUBSEQUENT write;
      // the read itself records nothing.
      if (typeof result.commit === 'string') anchorCommit = result.commit
      if (typeof result.hash === 'string') contentHash = result.hash
    } catch (e) {
      return fail(`cannot read ${file_path}: ${(e as Error).message}`)
    }
    const lines = raw.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const start = (offset ?? 1) - 1
    const slice = lines.slice(start, start + (limit ?? DEFAULT_READ_LIMIT))
    if (slice.length === 0) {
      return fail(`no lines in range, file has ${lines.length} lines, offset was ${offset ?? 1}`)
    }
    const numbered = slice
      .map((line, i) => {
        const clipped =
          line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + ' [line truncated]' : line
        return `${String(start + i + 1).padStart(6)}\t${clipped}`
      })
      .join('\n')
    const truncated = start + slice.length < lines.length
    const rangeNote = truncated ? `\n\n[showing lines ${start + 1}-${start + slice.length} of ${lines.length}]` : ''
    // The read anchor: which version these bytes came from, so the caller can pin it.
    const anchor = anchorCommit
      ? `\n\n[read at commit ${anchorCommit}${contentHash ? ` (content hash ${contentHash})` : ''}; pin this version as [[${file_path}::@${anchorCommit}]]]`
      : ''
    return ok(numbered + rangeNote + anchor)
  })

  const writeFileTool = callable('mcp.write_file', 'Write File', async (input) => {
    const file_path = optString(input, 'file_path')
    const content = optString(input, 'content')
    if (!file_path) return fail("'file_path' is required")
    if (content === undefined) return fail("'content' is required")
    if (!isAbsolute(file_path)) return fail(`file_path must be absolute, got: ${file_path}`)
    const guarded = guardWritePath(workspace, file_path)
    if (guarded) return fail(guarded)
    if (!broker || !broker.available()) return noEngine('write')
    // expected_hash: explicit from the caller, else the read-guard mediator injects it
    // (read-before-write). Absent -> the engine overwrites regardless (a new file).
    const expected_hash = optString(input, 'expected_hash')
    const args: Record<string, unknown> = { path: file_path, content }
    if (expected_hash !== undefined) args.expected_hash = expected_hash
    const stamps = optStamps(input)
    if (stamps) args.stamps = stamps
    forwardMixins(input, args)
    const attribution = optAttribution(input)
    if (attribution) args.attribution = attribution
    try {
      return mutationResult(workspace, await broker.mutate('write_file', args), file_path, 'wrote')
    } catch (e) {
      return fail(`cannot write ${file_path}: ${(e as Error).message}`)
    }
  })

  const editFileTool = callable('mcp.edit_file', 'Edit File', async (input) => {
    const file_path = optString(input, 'file_path')
    const old_string = optString(input, 'old_string')
    const new_string = optString(input, 'new_string')
    if (!file_path) return fail("'file_path' is required")
    if (old_string === undefined || new_string === undefined) {
      return fail("'old_string' and 'new_string' are required")
    }
    if (!isAbsolute(file_path)) return fail(`file_path must be absolute, got: ${file_path}`)
    if (old_string === new_string) return fail('old_string and new_string are identical')
    const guarded = guardWritePath(workspace, file_path)
    if (guarded) return fail(guarded)
    if (!broker || !broker.available()) return noEngine('edit')
    // The channel self-guards: a stale old_string misses the exact-unique match and
    // the engine rejects ("old_string not found — re-read and retry"). No local read.
    const replace_all = optBool(input, 'replace_all') ?? false
    const args: Record<string, unknown> = { path: file_path, old_string, new_string, replace_all }
    const stamps = optStamps(input)
    if (stamps) args.stamps = stamps
    forwardMixins(input, args)
    const attribution = optAttribution(input)
    if (attribution) args.attribution = attribution
    try {
      return mutationResult(workspace, await broker.mutate('edit_file', args), file_path, 'edited')
    } catch (e) {
      return fail(`cannot edit ${file_path}: ${(e as Error).message}`)
    }
  })

  // DESTRUCTIVE. Routes through the engine mutation channel like write/edit ([[decision -
  // 2606222008 ...]]); the rebuild drops the file's node from the graph. `expected_hash` is
  // the read-before-write guard (the read-guard mediator injects it if absent). Deleting an
  // absent file rejects engine-side — surfaced verbatim.
  const deleteFileTool = callable('mcp.delete_file', 'Delete File', async (input) => {
    const file_path = optString(input, 'file_path')
    if (!file_path) return fail("'file_path' is required")
    if (!isAbsolute(file_path)) return fail(`file_path must be absolute, got: ${file_path}`)
    const guarded = guardWritePath(workspace, file_path)
    if (guarded) return fail(guarded)
    if (!broker || !broker.available()) return noEngine('delete')
    const expected_hash = optString(input, 'expected_hash')
    const args: Record<string, unknown> = { path: file_path }
    if (expected_hash !== undefined) args.expected_hash = expected_hash
    // Attribution (commit trailers) is the ONE write rider a delete carries — daemon-injected, forwarded.
    const attribution = optAttribution(input)
    if (attribution) args.attribution = attribution
    try {
      return mutationResult(workspace, await broker.mutate('delete_file', args), file_path, 'deleted', { access: 'delete' })
    } catch (e) {
      return fail(`cannot delete ${file_path}: ${(e as Error).message}`)
    }
  })

  // Assign an engine-generated `^:` block id to the addressable entity enclosing byte offset
  // `at` (from a span the wire served — au_references / au_resolved body_events / au_instances).
  // Returns { id, ref } — `ref` is the `[[target^id]]` handle that resolves via au_follow.
  // Idempotent on an already-addressed record. Routes through the mutation channel.
  const assignBlockIdTool = callable('mcp.assign_block_id', 'Assign Block Id', async (input) => {
    const file_path = optString(input, 'file_path')
    const at = optNumber(input, 'at')
    if (!file_path) return fail("'file_path' is required")
    if (at === undefined || !Number.isFinite(at) || at < 0) {
      return fail("'at' is required (a non-negative byte offset inside the file, from a wire-served span)")
    }
    if (!isAbsolute(file_path)) return fail(`file_path must be absolute, got: ${file_path}`)
    const guarded = guardWritePath(workspace, file_path)
    if (guarded) return fail(guarded)
    if (!broker || !broker.available()) return noEngine('assign a block id')
    try {
      return mutationResult(workspace, await broker.mutate('assign_block_id', { path: file_path, at: Math.floor(at) }), file_path, 'assigned block id in')
    } catch (e) {
      return fail(`cannot assign a block id in ${file_path}: ${(e as Error).message}`)
    }
  })

  // Move a file and rewrite EVERY inbound reference to follow, as one saga (one Mutation-Id
  // across every repo touched). Same-repo only (a cross-repo `to` rejects); refuses a type-def
  // file (that is rename_type's job). Both paths are guarded + must be absolute. The refusal
  // surface (target exists, case-collision, clean-at-HEAD, drifted referrer) is surfaced verbatim.
  const renameTool = callable('mcp.rename', 'Rename', async (input) => {
    const file_path = optString(input, 'file_path')
    const to = optString(input, 'to')
    if (!file_path) return fail("'file_path' is required (the file to move)")
    if (!to) return fail("'to' is required (the new path)")
    if (!isAbsolute(file_path)) return fail(`file_path must be absolute, got: ${file_path}`)
    if (!isAbsolute(to)) return fail(`to must be absolute, got: ${to}`)
    const guarded = guardWritePath(workspace, file_path) ?? guardWritePath(workspace, to)
    if (guarded) return fail(guarded)
    if (!broker || !broker.available()) return noEngine('rename')
    const args: Record<string, unknown> = { path: file_path, to }
    const stamps = optStamps(input)
    if (stamps) args.stamps = stamps
    forwardMixins(input, args)
    try {
      return mutationResult(workspace, await broker.mutate('rename', args), to, 'renamed', { access: 'rename', from: file_path })
    } catch (e) {
      return fail(`cannot rename ${file_path}: ${(e as Error).message}`)
    }
  })

  // Rename a type-def: move its def file (the name derives from the filename) and cascade both
  // reference surfaces atomically (type-name refs in the owning repo + wikilinks to the def file
  // across the mounted set), as one saga. Takes TYPE NAMES, not a file path — old_name may be
  // bare or `::repo`-qualified to disambiguate an owner; new_name is the owner's own new name.
  const renameTypeTool = callable('mcp.rename_type', 'Rename Type', async (input) => {
    const old_name = optString(input, 'old_name')
    const new_name = optString(input, 'new_name')
    if (!old_name) return fail("'old_name' is required (the type-def name, bare or ::repo-qualified)")
    if (!new_name) return fail("'new_name' is required (the type-def's new name, bare)")
    if (!broker || !broker.available()) return noEngine('rename a type')
    try {
      // No input file path — the engine derives the moved def-file location; mutationResult
      // reads it back off `result.path`.
      return mutationResult(workspace, await broker.mutate('rename_type', { old_name, new_name }), undefined, `renamed type ${old_name} ->`)
    } catch (e) {
      return fail(`cannot rename type ${old_name}: ${(e as Error).message}`)
    }
  })

  // Extract an inline `^:` record out of a host file into its own file, leaving a `[[to]]`
  // reference and rewriting every inbound `[[host^id]]` referrer, as one saga. The record is
  // located by exactly one of `block_id` (a record with an id) or `at` (a byte offset for one
  // without). Guards both file_path (host) + to (new file).
  const promoteTool = callable('mcp.promote', 'Promote', async (input) => {
    const file_path = optString(input, 'file_path')
    const to = optString(input, 'to')
    const block_id = optString(input, 'block_id')
    const at = optNumber(input, 'at')
    if (!file_path) return fail("'file_path' is required (the host file holding the record)")
    if (!to) return fail("'to' is required (the new file path for the extracted record)")
    if (!isAbsolute(file_path)) return fail(`file_path must be absolute, got: ${file_path}`)
    if (!isAbsolute(to)) return fail(`to must be absolute, got: ${to}`)
    const hasBlockId = block_id !== undefined
    const hasAt = at !== undefined
    if (hasBlockId === hasAt) return fail("pass EXACTLY ONE record locator: 'block_id' (a record with a ^: id) or 'at' (a byte offset)")
    const guarded = guardWritePath(workspace, file_path) ?? guardWritePath(workspace, to)
    if (guarded) return fail(guarded)
    if (!broker || !broker.available()) return noEngine('promote')
    const args = hasBlockId ? { path: file_path, to, block_id } : { path: file_path, to, at: Math.floor(at!) }
    try {
      return mutationResult(workspace, await broker.mutate('promote', args), to, 'promoted to')
    } catch (e) {
      return fail(`cannot promote from ${file_path}: ${(e as Error).message}`)
    }
  })

  // The dual of promote: fold file `file_path` into host `into` as an inline `^:id` record and
  // delete `file_path`, rewriting referrers, as one saga. `at` (a byte offset in `into` landing
  // on the `[[file_path]]` reference) is required only when `into` references `file_path` more
  // than once. Guards both paths.
  const inlineTool = callable('mcp.inline', 'Inline', async (input) => {
    const file_path = optString(input, 'file_path')
    const into = optString(input, 'into')
    const at = optNumber(input, 'at')
    if (!file_path) return fail("'file_path' is required (the file to fold in and delete)")
    if (!into) return fail("'into' is required (the host file that references file_path)")
    if (!isAbsolute(file_path)) return fail(`file_path must be absolute, got: ${file_path}`)
    if (!isAbsolute(into)) return fail(`into must be absolute, got: ${into}`)
    const guarded = guardWritePath(workspace, file_path) ?? guardWritePath(workspace, into)
    if (guarded) return fail(guarded)
    if (!broker || !broker.available()) return noEngine('inline')
    const args: Record<string, unknown> = { path: file_path, into }
    if (at !== undefined) args.at = Math.floor(at)
    try {
      return mutationResult(workspace, await broker.mutate('inline', args), into, 'inlined into')
    } catch (e) {
      return fail(`cannot inline ${file_path}: ${(e as Error).message}`)
    }
  })

  // Rename an inline `^:` record's block-id in its host, rewriting every referrer filtered to
  // that id, as one saga. Scope is inline `^:` records only — a body-marker `^id` rejects.
  const renameBlockIdTool = callable('mcp.rename_block_id', 'Rename Block Id', async (input) => {
    const file_path = optString(input, 'file_path')
    const block_id = optString(input, 'block_id')
    const to_block_id = optString(input, 'to_block_id')
    if (!file_path) return fail("'file_path' is required (the host file holding the record)")
    if (!block_id) return fail("'block_id' is required (the record's current ^: id)")
    if (!to_block_id) return fail("'to_block_id' is required (the new id)")
    if (!isAbsolute(file_path)) return fail(`file_path must be absolute, got: ${file_path}`)
    const guarded = guardWritePath(workspace, file_path)
    if (guarded) return fail(guarded)
    if (!broker || !broker.available()) return noEngine('rename a block id')
    try {
      return mutationResult(workspace, await broker.mutate('rename_block_id', { path: file_path, block_id, to_block_id }), file_path, 'renamed block id in')
    } catch (e) {
      return fail(`cannot rename block id in ${file_path}: ${(e as Error).message}`)
    }
  })

  const globTool = callable('mcp.glob', 'Glob', async (input) => {
    const pattern = optString(input, 'pattern')
    if (!pattern) return fail("'pattern' is required")
    const path = optString(input, 'path')
    if (path !== undefined && !isAbsolute(path)) return fail(`path must be absolute, got: ${path}`)
    const base = path ?? workspace
    const matches: string[] = []
    try {
      for await (const m of glob(pattern, { cwd: base })) {
        matches.push(join(base, m))
        if (matches.length >= MAX_GLOB_RESULTS) break
      }
    } catch (e) {
      return fail(`glob failed: ${(e as Error).message}`)
    }
    if (matches.length === 0) return ok('No files found')
    const withTimes = await Promise.all(
      matches.map(async (p) => {
        try {
          return { p, mtime: (await stat(p)).mtimeMs }
        } catch {
          return { p, mtime: 0 }
        }
      }),
    )
    withTimes.sort((a, b) => b.mtime - a.mtime)
    const capped = matches.length >= MAX_GLOB_RESULTS ? `\n[capped at ${MAX_GLOB_RESULTS} results]` : ''
    return ok(withTimes.map((x) => x.p).join('\n') + capped)
  })

  const grepTool = callable('mcp.grep_files', 'Grep Files', async (input) => {
    const query = optString(input, 'query')
    if (!query) return fail("'query' is required")
    const path = optString(input, 'path')
    if (path !== undefined && !isAbsolute(path)) return fail(`path must be absolute, got: ${path}`)
    const base = path ?? workspace
    const globPat = optString(input, 'glob')
    const caseSensitive = optBool(input, 'case_sensitive')
    const mode = optString(input, 'mode') ?? 'content'
    if (mode !== 'content' && mode !== 'files' && mode !== 'count') {
      return fail(`mode must be one of "content" | "files" | "count", got: ${mode}`)
    }
    const limit = Math.max(1, optNumber(input, 'limit') ?? MAX_GREP_MATCHES)
    const offset = Math.max(0, optNumber(input, 'offset') ?? 0)
    const maxLineLength = optNumber(input, 'max_line_length') ?? DEFAULT_GREP_LINE_LEN
    let re: RegExp
    try {
      re = new RegExp(query, caseSensitive ? '' : 'i')
    } catch (e) {
      return fail(`bad query: ${(e as Error).message}`)
    }

    // Collect the matches: ripgrep (which handles `mode` via -l/-c) or the JS fallback
    // (always collects content lines, then reduceByMode folds them to files/count).
    const rg = await tryRipgrep(query, base, globPat, caseSensitive, mode)
    let out: string
    if (rg !== null) {
      out = rg
    } else {
      const raw: string[] = []
      try {
        for await (const m of glob(globPat ?? '**/*', { cwd: base })) {
          const file = join(base, m)
          let text: string
          try {
            text = await readFile(file, 'utf8')
          } catch {
            continue
          }
          const fileLines = text.split('\n')
          for (let i = 0; i < fileLines.length; i++) {
            if (re.test(fileLines[i])) raw.push(`${file}:${i + 1}:${fileLines[i]}`)
          }
        }
      } catch (e) {
        return fail(`grep failed: ${(e as Error).message}`)
      }
      out = reduceByMode(raw, mode)
    }

    if (out === 'No matches' || out === '') return ok('No matches')
    let resultLines = out.split('\n').filter((l) => l.length > 0)
    if (resultLines.length === 0) return ok('No matches')
    const total = resultLines.length
    // Truncate long lines only in `content` mode (files/count lines are short).
    if (mode === 'content' && maxLineLength > 0) {
      resultLines = resultLines.map((l) =>
        l.length > maxLineLength ? `${l.slice(0, maxLineLength)}…[+${l.length - maxLineLength} chars]` : l,
      )
    }
    // Paginate: a page of `limit` results starting at `offset`.
    const page = resultLines.slice(offset, offset + limit)
    if (page.length === 0) {
      return ok(offset >= total ? `No matches at offset ${offset} (of ${total} total)` : 'No matches')
    }
    const end = offset + page.length
    const more = end < total
    const footer =
      offset > 0 || more
        ? `\n[showing ${offset + 1}–${end} of ${total}${more ? `; use offset=${end} for the next page` : ''}]`
        : ''
    return ok(page.join('\n') + footer)
  })

  // SIGNAL-CAPTURING STUB ([[decision - 2606250955 ...]]). Still advertised, so the
  // reach + the attempted `command` are captured as a `toolCall(bash)` in the trace.
  // It does NOT execute (no child_process) — closes the escape hatch (P7-O5) + the
  // main roaming vector (P7-O6) and harvests the demand signal. Returns `ok` so the
  // agent gets guidance, not a hard failure to loop on.
  const bashTool = callable('mcp.bash', 'Bash', async (_input) => ok(BASH_STUB_MESSAGE))

  // DECLARE each tool's engine access on its manifest (least privilege), by OBJECT — the
  // mutation-channel verbs are `read-write`, the engine content-read is `read`, and the
  // fs-only tools (glob/grep) + the bash stub keep the default `none`. This is the name-free
  // source a guard reads at decide (MediationContext.accessOf) instead of a verb list.
  for (const t of [writeFileTool, editFileTool, deleteFileTool, assignBlockIdTool, renameTool, renameTypeTool, promoteTool, inlineTool, renameBlockIdTool]) {
    if (t.manifest.kind === 'tool') t.manifest.access = 'read-write'
  }
  if (readFileTool.manifest.kind === 'tool') readFileTool.manifest.access = 'read'

  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    deleteFileTool,
    assignBlockIdTool,
    renameTool,
    renameTypeTool,
    promoteTool,
    inlineTool,
    renameBlockIdTool,
    globTool,
    grepTool,
    bashTool,
  ]
}

/** The file path out of a `path:line:content` match line (path may not contain `:line:`). */
function grepMatchFile(line: string): string {
  const m = /^(.*?):\d+:/.exec(line)
  return m ? m[1] : line
}

/** Fold raw `path:line:content` lines to the requested mode (the JS-fallback path). */
function reduceByMode(contentLines: string[], mode: string): string {
  if (mode === 'files') return [...new Set(contentLines.map(grepMatchFile))].join('\n')
  if (mode === 'count') {
    const counts = new Map<string, number>()
    for (const l of contentLines) {
      const f = grepMatchFile(l)
      counts.set(f, (counts.get(f) ?? 0) + 1)
    }
    return [...counts].map(([f, c]) => `${f}:${c}`).join('\n')
  }
  return contentLines.join('\n') // content
}

/** Try ripgrep; null means rg is unavailable or errored, so the caller falls back. */
function tryRipgrep(
  query: string,
  cwd: string,
  globPat: string | undefined,
  caseSensitive: boolean | undefined,
  mode: string,
): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const args = ['--color', 'never']
    if (mode === 'files') args.push('--files-with-matches') // -l: matching paths only
    else if (mode === 'count') args.push('--count') // -c: `path:count` per matching file
    else args.push('--line-number', '--no-heading') // content: `path:line:match`
    if (!caseSensitive) args.push('-i')
    if (globPat) args.push('--glob', globPat)
    args.push('--', query)
    execFile('rg', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      const code = (err as { code?: unknown } | null)?.code
      if (code === 'ENOENT') return resolvePromise(null) // rg not installed -> fall back
      if (code === 1) return resolvePromise('No matches') // rg: clean no-match
      if (err) return resolvePromise(null) // other rg error -> fall back to JS scan
      resolvePromise(stdout.trim() || 'No matches')
    })
  })
}

// Loadable-plugin adapter (plan 2608261532): extract ONE file tool's invoke by id, for a thin
// per-tool `createPlugin` entry. Reuses the `fileTools()` closures verbatim; the daemon derives
// the manifest from the def and injects write-stamps at its invoke seam (keyed by tool id), so a
// loadable write is governed identically to the old literal.
export function fileToolInvoke(
  id: string,
  workspace: string,
  broker: PluginBroker | undefined,
): (input: unknown) => Promise<CallableResult> {
  const tool = fileTools(workspace, broker).find((p) => p.manifest.id === id)
  if (!tool?.invoke) return async () => fail(`unknown file tool: ${id}`)
  return tool.invoke as (input: unknown) => Promise<CallableResult>
}
