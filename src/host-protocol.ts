// The agent-host transport PROTOCOL — au-mcp's local mirror of au-host-sdk's wire types.
//
// STANDIN(host-transport-protocol): au-host-sdk OWNS this protocol
// (`@arsumbris/au-host-sdk` `src/transport.ts`). au-mcp is the CLIENT. We mirror the
// ~handful of wire shapes here rather than import the package, because host-sdk is
// a package nested INSIDE the au-host repo, not an extracted importable sibling
// module yet. These are type-only (the sole external referent, `PaneId`, is just a
// string), so the mirror is small and mechanical.
//
// SWAP PATH: replace this file's types with
//   `import type { ... } from '@arsumbris/au-host-sdk'`
// once au-host-sdk is extracted / importable across the repo boundary. The byte
// framing already comes from `@arsumbris/au-engine-sdk` (`encodeFrame`/`FrameDecoder`)
// on both ends, so it never needs mirroring.
//
// See [[decision - 2607110102 - the agent-facing intent surface is a generic
// list-fire pair over au-host intent subtypes discovered via the type graph, not
// per-intent tools::au-harness]] and the au-host source of truth
// [[transport.ts::au-host]].

/**
 * The transport protocol version, bumped on any breaking command-set change.
 * The server and this client must agree. Mirror of au-host-sdk's constant.
 */
export const HOST_TRANSPORT_PROTOCOL_VERSION = 1

/**
 * A fired intent's payload. The host reads only `type` / `kind` / `dispatch` and
 * forwards the rest verbatim (payload-opaque). au-host-sdk's own `IntentPayload`
 * has no index signature (its scratch client casts); we allow extra opaque fields
 * because au-mcp is the side that BUILDS the payload from agent input.
 */
export interface IntentPayload {
  type: string
  kind?: string
  dispatch?: string
  [key: string]: unknown
}

// --- Commands ---------------------------------------------------------------

/** A command a client sends to the host. */
export type HostCommand =
  | { command: 'fireIntent'; intent: IntentPayload }
  | { command: 'introspect' }
  | { command: 'containerOp'; op: ContainerOp }

/** The result for each command, discriminated by the same `command` tag. */
export type HostResult =
  | { command: 'fireIntent'; claimed: boolean }
  | { command: 'introspect'; snapshot: HostSnapshot }
  | { command: 'containerOp'; outcome: ContainerOpOutcome }

// --- Frames -----------------------------------------------------------------
//
// One JSON message per wire frame (the 4-byte length prefix + JSON body is
// engine-sdk's `encodeFrame` / `FrameDecoder`, reused verbatim by both ends).
// Every request carries a client-minted correlation id; the response echoes it.

/** A request frame: a correlation id plus the command. */
export interface HostRequestFrame {
  /** Client-minted, monotonic. The matching response echoes it. */
  id: number
  request: HostCommand
}

/** A response frame: the echoed id and either a typed result or an error. A
 *  command never throws across the wire — a failure is `ok: false` with a reason. */
export type HostResponseFrame =
  | { id: number; ok: true; result: HostResult }
  | { id: number; ok: false; error: string }

// --- introspect: the live snapshot -----------------------------------------

/** One node of the mounted composition tree. */
export interface SnapshotNode {
  /** The node's stable id in the mount tree. */
  id: string
  /** The projection subtype name mounted here, or null. */
  projection: string | null
  /** The projection KIND closure (type name + every ancestor kind it plays). */
  kinds: string[]
  /** The intent `type`s this node's projection declares it handles (bare names). */
  handles: string[]
  /** Child nodes, in mount order. */
  children: SnapshotNode[]
}

/** The focus state accompanying a snapshot. */
export interface SnapshotFocus {
  /** The most-recently-focused node id, if any. */
  activeNodeId?: string
}

/** A snapshot of the live host composition. */
export interface HostSnapshot {
  root: SnapshotNode
  focus: SnapshotFocus
}

// --- containerOp: the ContainerPlacement seam ------------------------------

/** A container operation. The union is open by design (move verbs deferred). */
export type ContainerOp = { op: 'activate'; paneId: string }

/** The outcome of a container operation. */
export type ContainerOpOutcome = { done: true } | { done: false; reason: string }

// --- The client contract ----------------------------------------------------

/**
 * The client half of the transport: what au-mcp's host-relay path implements to
 * reach au-host. au-host-sdk OWNS the protocol; au-mcp CONNECTS. `send` rejects on
 * transport failure (a closed socket, a version mismatch); a command-level failure
 * returns as an `ok: false` frame the caller surfaces, not a reject.
 */
export interface HostRelayClient {
  send(command: HostCommand): Promise<HostResult>
  close(): void
}
