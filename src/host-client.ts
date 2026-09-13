// The host-relay socket client — au-mcp's half of the agent-host transport.
//
// au-host SERVES a per-workspace socket; au-mcp CONNECTS as a client and relays a
// tool call as a `fireIntent` / `introspect` / `containerOp` command. Discovery
// does NOT ride this socket (it goes over the engine type graph); the socket is a
// live/ephemeral command channel only.
//
// The byte framing (`encodeFrame` / `FrameDecoder`) and the socket-path hashing
// (`socketFileName`) are engine-sdk's, reused verbatim so both ends agree by
// construction. The wire protocol types are the local STANDIN mirror in
// `./host-protocol.ts`. Reference client: [[host-bridge-live.ts::au-host]].
//
// Part of Ask 1 of [[message - 260708195240 - request the au-mcp half of the
// agent-host transport plus mcp.skill]], per
// [[decision - 2607110102 - the agent-facing intent surface is a generic list-fire
// pair over au-host intent subtypes discovered via the type graph, not per-intent
// tools]].

import * as net from 'node:net'
import { existsSync, realpathSync } from 'node:fs'
import * as path from 'node:path'

import { auDeviceDir, encodeFrame, FrameDecoder, socketFileName } from '@arsumbris/au-engine-sdk'

import type { HostCommand, HostResult, HostRequestFrame, HostResponseFrame } from './host-protocol.ts'

/**
 * The host socket path for a workspace entry: `$HOME/.arsumbris/au-host/run/<hash>.host.sock`.
 *
 * The socket is au-host's OWNED resource, so it lives under au-host's device tenant
 * (`~/.arsumbris/au-host/run/`); au-mcp is a CLIENT that re-derives where to dial. We
 * build the dir off the SAME engine-sdk primitive au-host's own `hostRunDir()` uses
 * (`auDeviceDir('au-host','run')`), so the two ends share ONE path source and can never
 * drift apart. Only the filename differs from the engine socket: realpath the entry,
 * `socketFileName` it to `<hash>.sock`, swap `.sock` -> `.host.sock`. Same `<hash>` as
 * the engine socket for the same workspace (au-host derives it identically). `entry` is
 * the workspace the daemon serves (a folder-repo DIRECTORY carrying `.arsumbris/repo.yaml`,
 * schema 16).
 */
export function hostSocketPath(entry: string): string {
  const canonical = realpathSync(entry)
  const fileName = socketFileName(canonical).replace(/\.sock$/, '.host.sock')
  return path.join(auDeviceDir('au-host', 'run'), fileName)
}

/** Whether a host appears to be serving for this workspace (its socket exists). */
export function hostAvailable(entry: string): boolean {
  try {
    return existsSync(hostSocketPath(entry))
  } catch {
    return false
  }
}

/** The client half of the transport (mirrors au-host-sdk's `HostRelayClient`). */
export interface HostRelayClient {
  /** Send one command, await its correlated result. Rejects on transport failure
   *  or a command-level `ok: false` (au-mcp collapses both to a rejection its tool
   *  layer surfaces as a tool error; au-host's contract distinguishes them). */
  send(command: HostCommand): Promise<HostResult>
  /** Close the connection. Idempotent. Pending sends reject. */
  close(): void
}

/** Options for {@link connectHostRelayClient}. */
export interface HostConnectOptions {
  /** Connect attempts before giving up (au-host may arm the socket just after us). */
  retries?: number
  /** Delay between connect attempts, ms. */
  retryDelayMs?: number
  /** Per-send timeout, ms. */
  sendTimeoutMs?: number
}

const DEFAULTS = { retries: 5, retryDelayMs: 120, sendTimeoutMs: 4000 }

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Connect to the host socket for `entry` and return a {@link HostRelayClient}.
 *
 * Retries the initial connect (readiness: the renderer arms the socket once a
 * composition mounts, possibly just after au-mcp asks). Rejects if it cannot
 * connect after `retries` attempts. The returned client multiplexes commands over
 * one connection, correlating each reply by its echoed `id`.
 *
 * Tools use this connect-per-call (connect, send one command, close) — short-lived
 * and robust to the host restarting, mirroring the engine broker's connect-per-call
 * model.
 */
export async function connectHostRelayClient(
  entry: string,
  opts: HostConnectOptions = {},
): Promise<HostRelayClient> {
  const { retries, retryDelayMs, sendTimeoutMs } = { ...DEFAULTS, ...opts }
  const socketPath = hostSocketPath(entry)
  const socket = await connectWithRetry(socketPath, retries, retryDelayMs)
  return makeClient(socket, sendTimeoutMs)
}

/** Connect to a socket path, retrying a bounded number of times. */
async function connectWithRetry(socketPath: string, retries: number, retryDelayMs: number): Promise<net.Socket> {
  let lastErr: Error | undefined
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await connectOnce(socketPath)
    } catch (err) {
      lastErr = err as Error
      if (attempt < retries) await delay(retryDelayMs)
    }
  }
  throw new Error(`host socket unreachable at ${socketPath} after ${retries + 1} attempts: ${lastErr?.message}`)
}

/** One connect attempt, resolving on 'connect', rejecting on 'error'. */
function connectOnce(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const onError = (err: Error) => {
      socket.destroy()
      reject(err)
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.removeListener('error', onError)
      resolve(socket)
    })
  })
}

type Pending = {
  resolve: (result: HostResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Wrap a connected socket in the id-correlating client. */
function makeClient(socket: net.Socket, sendTimeoutMs: number): HostRelayClient {
  const decoder = new FrameDecoder()
  const pending = new Map<number, Pending>()
  let nextId = 1
  let closed = false

  const settleAll = (err: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  socket.on('data', (chunk: Buffer) => {
    for (const value of decoder.push(chunk)) {
      const frame = value as HostResponseFrame
      const p = pending.get(frame.id)
      if (!p) continue // an id we no longer track; ignore
      pending.delete(frame.id)
      clearTimeout(p.timer)
      if (frame.ok) p.resolve(frame.result)
      else p.reject(new Error(frame.error))
    }
  })
  socket.on('error', (err) => settleAll(err))
  socket.on('close', () => {
    if (!closed) settleAll(new Error('host socket closed'))
  })

  return {
    send(command: HostCommand): Promise<HostResult> {
      if (closed) return Promise.reject(new Error('host relay client is closed'))
      const id = nextId++
      return new Promise<HostResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`host command '${command.command}' (id ${id}) timed out`))
        }, sendTimeoutMs)
        pending.set(id, { resolve, reject, timer })
        socket.write(encodeFrame({ id, request: command } satisfies HostRequestFrame))
      })
    },
    close() {
      if (closed) return
      closed = true
      settleAll(new Error('host relay client is closed'))
      socket.end()
    },
  }
}
