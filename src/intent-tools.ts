// Host-relay intent tools — the agent-facing surface over au-host's `intent` vocab.
//
// A GENERIC PAIR, not one tool per intent (decision 2607110102):
//   - au_host_intent_fire  — fire an intent into the live composition (this file, Phase 2).
//   - au_host_intent_list — the catalog + live handled set (Phase 3).
// Intents are DISCOVERED via the engine type graph (`subtypes('intent')` / `type`),
// not the socket. The host socket carries only the fire + introspect commands.
//
// au-host owns the `intent` vocabulary (its `intent` package): the base + subtypes
// (`open-intent`, `ui-intent-highlight`, ...), the `intent-routing-meta` (kind /
// dispatch) and `intent-agent-meta` (firable) each carries, and the projections'
// `handles`. We read those off the type graph and relay over the [[client.ts]]
// host-relay client. `au_host_intent_list` FLAGS firability (agent_firable), never filters:
// the host's fireIntent is default-deny + has a derived payload check we do not mirror.
//
// Ask 1 of [[message - 260708195240 - request the au-mcp half of the agent-host
// transport plus mcp.skill]], per [[plan - 2607141759 - build the au-mcp host-relay
// client and generic intent surface over au-host intent subtypes]].

import type { Plugin, CallableResult } from '@arsumbris/au-mcp-sdk'
import type { PluginBroker } from '@arsumbris/au-mcp-sdk'
import { ok, fail, optString, optObject, ENGINE_DOWN_HINT } from './result.ts'
import { connectHostRelayClient, hostAvailable } from './host-client.ts'
import type { IntentPayload, HostSnapshot, SnapshotNode, ContainerOp } from './host-protocol.ts'

// Host-relay tools: they relay over the host socket and (for list/fire) do read-only engine
// lookups, none mutate the graph. Declared `none` (no owned mutation-channel access) — the
// coarse-but-safe class for the guard; refine per-tool if a host-relay verb ever mutates.
function callable(id: string, name: string, invoke: (input: unknown) => Promise<CallableResult>): Plugin {
  return { manifest: { id, name, kind: 'tool', contractVersion: 0, access: 'none' }, invoke }
}

// --- reading a type-def's meta off the wire --------------------------------
// The `type` / `subtypes` reads return defs with `meta_blocks`. Same shape +
// base-name matching discovery.ts uses (replicated small; not exported there).

interface WireMetaBlock {
  type_name: string
  body: { name: string; value: unknown }[]
}
interface WireField {
  name: string
  shape?: string
  required?: boolean
  doc?: string
}
interface WireDef {
  name?: string
  repo?: string
  doc?: string
  fields?: WireField[]
  meta_blocks?: WireMetaBlock[]
}
/** Match a meta block by BASE name, tolerant of a `::repo` import qualifier. */
const metaIs = (b: WireMetaBlock, base: string): boolean => b.type_name.split('::', 1)[0] === base
/** Flatten a meta block's `[{name, value}]` body into a record. */
const metaRecord = (b: WireMetaBlock): Record<string, unknown> =>
  Object.fromEntries(b.body.map((f) => [f.name, f.value]))

const ROUTING_META = 'intent-routing-meta'
const AGENT_META = 'intent-agent-meta'

interface Routing {
  kind?: string
  dispatch?: string
}

/** An intent's routing (`kind` / `dispatch`) read off a def's `intent-routing-meta`. */
function routingOf(def: WireDef | null): Routing {
  const block = def?.meta_blocks?.find((b) => metaIs(b, ROUTING_META))
  if (!block) return {}
  const rec = metaRecord(block)
  const out: Routing = {}
  if (typeof rec.kind === 'string') out.kind = rec.kind
  if (typeof rec.dispatch === 'string') out.dispatch = rec.dispatch
  return out
}

/**
 * Whether an intent is agent-firable, read off its LITERAL `intent-agent-meta { firable }`.
 *
 * au-host's `fireIntent` is DEFAULT-DENY (its audit-1 F1 fix): an intent fires only if its
 * type-def declares `intent-agent-meta` with `firable: true`. An absent block, or a non-`true`
 * field, means NOT firable. Never inherited — a subtype adds fields, so it must re-declare —
 * which is why we read the def's OWN `meta_blocks` (the same literal read `routingOf` uses),
 * matching the host's rule rather than a resolved/merged view.
 *
 * We surface this as a FLAG, never a filter: the host may still refuse a `firable`-declared
 * intent via a DERIVED payload check (an arbitrary-projection/`any` field), which is au-host's
 * concern and deliberately NOT reimplemented here. So the flag reports the DECLARED gate
 * honestly, and an agent can see WHY a verb is unavailable instead of retrying a hidden one.
 */
function agentFirableOf(def: WireDef | null): boolean {
  const block = def?.meta_blocks?.find((b) => metaIs(b, AGENT_META))
  return block ? metaRecord(block).firable === true : false
}

/**
 * The host `fireIntent` refusal codes (au-host's default-deny gate). They arrive as an
 * `ok:false` frame the host-relay client collapses into a rejected `send` (its contract
 * intentionally merges transport failures and command refusals). We re-split here so a
 * refusal reads as a NORMAL, coded outcome rather than a transport failure.
 */
const FIRE_REFUSAL_CODES = [
  'unknown-intent-type',
  'not-declared-agent-firable',
  'declared-not-agent-firable',
  'privileged-payload',
]

/** Render a rejected `fireIntent` send: a coded firability/payload REFUSAL vs a transport failure. */
export function fireErrorMessage(intentType: string, message: string): string {
  const code = FIRE_REFUSAL_CODES.find((c) => message.includes(c))
  if (code) {
    return (
      `Intent ${intentType} was refused by the host (${code}): ${message}\n` +
      'An intent must declare `intent-agent-meta { firable: true }` to be firable — call au_host_intent_list and check `agent_firable`.'
    )
  }
  return `intent fire failed: ${message}`
}

/** One `type` read -> the intent's def (routing, owner repo, fields). null when unresolvable. */
async function readDef(broker: PluginBroker, name: string): Promise<WireDef | null> {
  try {
    const frame = await broker.read('type', { name })
    if (frame.ready === false || frame.type === 'error') return null
    return (frame.result as WireDef | null) ?? null
  } catch {
    return null
  }
}

/** Required fields the payload is missing (empty when the def is unknown -> best-effort). */
function requiredMissing(def: WireDef | null, payload: Record<string, unknown>): WireField[] {
  if (!def?.fields) return []
  return def.fields.filter((f) => f.required === true && !(f.name in payload))
}

/** The union of `handles` (intent type names) declared across the mounted tree. */
function collectHandles(node: SnapshotNode | undefined, acc: Set<string> = new Set()): Set<string> {
  if (!node) return acc
  for (const h of node.handles ?? []) acc.add(h)
  for (const child of node.children ?? []) collectHandles(child, acc)
  return acc
}

interface ValidateDiagnostic {
  code?: string
  severity?: string
  message?: string
}
/** A schema-17 multi-fit verdict (mirror of validate.ts): identity null = the intent def did not resolve. */
interface ValidateVerdict {
  identity: { name?: string; repo?: string; hash?: string } | null
  diagnostics?: ValidateDiagnostic[]
}
// Synthesis-artifact codes — non-blocking ONLY on a verdict whose identity RESOLVED
// (mirror of validate.ts). They come from the payload's own `type` field colliding with
// the engine's synthetic `type:` claim, not from a malformed payload. An
// `unknown-type-claim` on a NULL-identity verdict (the intent def itself missing) is the
// fail-closed case below, not this set.
const NON_BLOCKING = new Set(['unknown-type-claim', 'duplicate-key-in-mapping'])

/**
 * Validate a fired intent's payload against its `intent` subtype def. Returns a
 * human-readable refusal when invalid OR when the def does not resolve (fail-closed,
 * like the tool-input gate — an unmounted intent owner means an unreliable graph), or
 * null to proceed. A transport gap (no engine / busy / timeout) still proceeds.
 */
async function validatePayload(
  broker: PluginBroker,
  intentType: string,
  payload: Record<string, unknown>,
  repo?: string,
): Promise<string | null> {
  if (!broker.available()) return null
  try {
    // Scope to the intent's OWNER repo so the name resolves (au-host owns the
    // `intent` vocab); without it a cross-repo type reads `unknown-type-claim`
    // and validation silently skips.
    const frame = await broker.read('validate_value', { type_name: intentType, value: payload, ...(repo ? { repo } : {}) })
    if (frame.ready === false || frame.type === 'error') return null
    const verdicts = Array.isArray(frame.result) ? (frame.result as ValidateVerdict[]) : []
    // FAIL-CLOSED: a null-identity verdict means the intent def did not resolve (its owner
    // — au-host — is not a mounted member), so the type graph is unreliable. Refuse.
    const unresolved = verdicts.filter((v) => v.identity === null)
    if (unresolved.length > 0) {
      const diags = unresolved.flatMap((v) => v.diagnostics ?? [])
      return diags.length
        ? diags.map((d) => `  - ${d.code ?? 'unresolved'}: ${d.message ?? ''}`).join('\n')
        : `  - ${intentType} did not resolve (is its owning repo mounted as a dependency?)`
    }
    const diags = verdicts.flatMap((v) => v.diagnostics ?? [])
    const blocking = diags.filter((d) => d.severity === 'error' && !NON_BLOCKING.has(d.code ?? ''))
    if (blocking.length === 0) return null
    return blocking.map((d) => `  - ${d.code ?? 'invalid'}: ${d.message ?? 'invalid'}`).join('\n')
  } catch {
    return null
  }
}

/**
 * The host-relay intent tools. `workspace` is the entry the daemon serves — the
 * host socket is derived from it (same hash as the engine socket, `.host.sock`).
 */
export function intentTools(broker: PluginBroker, workspace?: string): Plugin[] {
  return [
    callable(
      'mcp.au_host_pane_op',
      'Host: a live layout operation on the mounted composition (a single dispatcher — activate now)',
      async (input) => {
        const op = optString(input, 'op')
        if (!op) {
          return fail('\'op\' is required (the layout operation). Today: "activate" (reveal/focus a pane by id).')
        }
        if (!workspace) return fail('no workspace bound to this daemon; cannot reach the host')
        const paneId = optString(input, 'paneId') ?? optString(input, 'pane_id')
        if (op === 'activate' && !paneId) {
          return fail("'activate' needs 'paneId' (the pane to reveal/focus). Get pane ids from au_host_snapshot (each node's `id`).")
        }
        // The verb + its params; the host reads them and declines with a reason if
        // it can't act (e.g. no container holds the pane).
        const containerOp = { op, ...(paneId ? { paneId } : {}) } as unknown as ContainerOp

        if (!hostAvailable(workspace)) {
          return fail('no host is running for this workspace (open the au-host app on it). The operation was NOT performed.')
        }
        let client
        try {
          client = await connectHostRelayClient(workspace)
        } catch (e) {
          return fail(`could not reach the host: ${(e as Error).message}`)
        }
        try {
          const result = await client.send({ command: 'containerOp', op: containerOp })
          return ok((result as { outcome?: unknown }).outcome ?? result)
        } catch (e) {
          return fail(`container op failed: ${(e as Error).message}`)
        } finally {
          client.close()
        }
      },
    ),

    callable(
      'mcp.au_host_snapshot',
      'Host: a snapshot of the live composition — the mounted projection tree + focus',
      async () => {
        if (!workspace) return fail('no workspace bound to this daemon; cannot reach the host')
        if (!hostAvailable(workspace)) {
          return fail('no host is running for this workspace (open the au-host app on it). There is no live composition to inspect.')
        }
        let client
        try {
          client = await connectHostRelayClient(workspace)
        } catch (e) {
          return fail(`could not reach the host: ${(e as Error).message}`)
        }
        try {
          const result = await client.send({ command: 'introspect' })
          const snapshot = (result as { snapshot?: HostSnapshot }).snapshot
          if (!snapshot) return fail('the host returned no snapshot')
          // The full live structure: the mounted tree (per node: id, projection type,
          // kind closure, handled intents, children) + the focus head.
          return ok({ host_present: true, root: snapshot.root, focus: snapshot.focus })
        } catch (e) {
          return fail(`introspect failed: ${(e as Error).message}`)
        } finally {
          client.close()
        }
      },
    ),

    callable(
      'mcp.au_host_intent_list',
      'Host: the UI intents an agent can fire — the catalog + which are live right now',
      async () => {
        if (!broker.available()) {
          return fail(`no engine reachable — cannot discover intents. ${ENGINE_DOWN_HINT}`)
        }
        // The catalog: every `intent` subtype, with its docstring, payload fields
        // (each with its own docstring), and routing. One `subtypes` read carries
        // full defs (name/repo/doc/fields/meta_blocks) — no per-intent fetch.
        let defs: WireDef[]
        try {
          const frame = await broker.read('subtypes', { base: 'intent' })
          if (frame.ready === false) return fail('engine not ready (ref still deriving)')
          if (frame.type === 'error') return fail(JSON.stringify(frame, null, 2))
          const res = frame.result as { subtypes?: WireDef[] } | WireDef[] | null
          defs = Array.isArray(res) ? res : (res?.subtypes ?? [])
        } catch (e) {
          return fail(`could not read intents: ${(e as Error).message}. ${ENGINE_DOWN_HINT}`)
        }

        const catalog = defs.map((def) => {
          const routing = routingOf(def)
          return {
            intent: def.name,
            ...(def.repo ? { repo: def.repo } : {}),
            ...(def.doc ? { description: def.doc } : {}),
            ...(routing.kind ? { kind: routing.kind } : {}),
            ...(routing.dispatch ? { dispatch: routing.dispatch } : {}),
            // The host is default-deny: an intent fires only if its def declares
            // `intent-agent-meta { firable: true }`. FLAG it (never filter) so a refused
            // intent stays discoverable with its reason. Absent => false. See agentFirableOf.
            agent_firable: agentFirableOf(def),
            payload: (def.fields ?? []).map((f) => ({
              name: f.name,
              ...(f.shape ? { shape: f.shape } : {}),
              required: f.required === true,
              ...(f.doc ? { description: f.doc } : {}),
            })),
          }
        })

        if (catalog.length === 0) {
          return ok({ intents: [], note: 'No intents defined in this workspace. Is a UI package (au-host) mounted as a member?' })
        }

        // Enrich with the LIVE handled set — what the mounted composition responds
        // to right now (introspect over the host socket). Best-effort: no host ->
        // the static catalog, flagged.
        if (!workspace || !hostAvailable(workspace)) {
          return ok({
            host_present: false,
            note: 'No host running for this workspace; showing the static catalog only. Firing needs the au-host app open on it.',
            intents: catalog,
          })
        }
        let handled: Set<string>
        let activeNode: string | undefined
        let client
        try {
          client = await connectHostRelayClient(workspace)
          const result = await client.send({ command: 'introspect' })
          const snapshot = (result as { snapshot?: HostSnapshot }).snapshot
          handled = collectHandles(snapshot?.root)
          activeNode = snapshot?.focus?.activeNodeId
        } catch (e) {
          // Host went away between the check and the call — still useful: the catalog.
          return ok({ host_present: true, live_error: (e as Error).message, intents: catalog })
        } finally {
          client?.close()
        }
        const intents = catalog.map((c) => ({ ...c, live: c.intent ? handled.has(c.intent) : false }))
        return ok({ host_present: true, ...(activeNode ? { active_node: activeNode } : {}), intents })
      },
    ),

    callable(
      'mcp.au_host_intent_fire',
      'Host: fire a UI intent into the live au-host composition',
      async (input) => {
        const intentType = optString(input, 'intent')
        if (!intentType) {
          return fail("'intent' is required (the intent type name, e.g. \"open-intent\"). Call au_host_intent_list to see what's available + each intent's payload shape.")
        }
        if (!workspace) return fail('no workspace bound to this daemon; cannot reach the host')

        // Payload: an object, or a JSON-object STRING (agents reach for a stringified
        // mapping — the au_validate dogfood saw 6 failed tries). An array/scalar is an error.
        const payloadObj = optObject(input, 'payload')
        let payload: Record<string, unknown> = payloadObj ?? {}
        if (payloadObj === undefined) {
          const raw = optString(input, 'payload')
          if (raw !== undefined) {
            try {
              const parsed = JSON.parse(raw)
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
              else return fail("'payload' must be a JSON object (a mapping of the intent's fields), not a scalar or array.")
            } catch {
              return fail("'payload' is a string but not valid JSON. Pass a JSON object of the intent's fields, e.g. {\"target\": {...}, \"mode\": \"...\"}.")
            }
          }
        }

        // Read the intent def ONCE — routing (kind/dispatch), owner repo, and fields.
        const def = await readDef(broker, intentType)

        // Refuse a payload missing REQUIRED fields. A targetless highlight (or a
        // fieldless open) is silently no-op'd by the host — claimed:true but nothing
        // happens. Turn that into an actionable error, using the def's own field
        // docstrings so the agent self-corrects without a round-trip.
        const missing = requiredMissing(def, payload)
        if (missing.length > 0) {
          const lines = missing.map((f) => `  - ${f.name}${f.shape ? ` (${f.shape})` : ''}${f.doc ? `: ${f.doc}` : ''}`)
          return fail(
            `Intent ${intentType} needs required field(s) missing from 'payload':\n${lines.join('\n')}\n` +
              'Call au_host_intent_list for the full payload shape.',
          )
        }

        // Deeper shape validation, scoped to the intent's owner repo. Fail-closed: if the
        // def does not resolve (owner unmounted) the refusal is raised, not skipped.
        const invalid = await validatePayload(broker, intentType, payload, def?.repo)
        if (invalid) return fail(`Invalid payload for intent ${intentType}:\n${invalid}`)

        // Stamp routing (kind/dispatch) off the type graph unless the caller set it.
        const routing = routingOf(def)
        const intent: IntentPayload = { type: intentType, ...payload }
        if (routing.kind !== undefined && intent.kind === undefined) intent.kind = routing.kind
        if (routing.dispatch !== undefined && intent.dispatch === undefined) intent.dispatch = routing.dispatch

        // Relay over the host socket. Live/ephemeral only.
        if (!hostAvailable(workspace)) {
          return fail('no host is running for this workspace (open the au-host app on it). The intent was NOT fired.')
        }
        let client
        try {
          client = await connectHostRelayClient(workspace)
        } catch (e) {
          return fail(`could not reach the host: ${(e as Error).message}`)
        }
        try {
          const result = await client.send({ command: 'fireIntent', intent })
          return ok(result)
        } catch (e) {
          // A firability/payload REFUSAL (default-deny) arrives here too — the host-relay
          // client collapses an `ok:false` frame into a rejection. fireErrorMessage re-splits
          // a coded refusal (a normal outcome now) from a real transport failure.
          return fail(fireErrorMessage(intentType, (e as Error).message))
        } finally {
          client.close()
        }
      },
    ),
  ]
}

// Loadable-plugin adapter (plan 2608261532): extract ONE intent/host-relay tool's invoke by id,
// for a thin per-tool `createPlugin` entry. Reuses the `intentTools()` invoke closures verbatim;
// the daemon derives the manifest from the def and supplies only the runtime.
export function intentToolInvoke(
  id: string,
  broker: PluginBroker | undefined,
  workspace?: string,
): (input: unknown) => Promise<CallableResult> {
  if (!broker) return async () => fail('no engine reachable')
  const tool = intentTools(broker, workspace).find((p) => p.manifest.id === id)
  if (!tool?.invoke) return async () => fail(`unknown intent tool: ${id}`)
  return tool.invoke as (input: unknown) => Promise<CallableResult>
}
