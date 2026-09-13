// Phase 1 of [[plan - 2607141759 - build the au-mcp host-relay client and generic
// intent surface over au-host intent subtypes]]: prove the host-relay client in
// isolation — framing round-trip, id correlation, ok:false surfacing, transport
// failure — against a FAKE in-process socket server. No au-host app needed.

import { describe, it, expect, afterEach } from 'vitest'
import * as net from 'node:net'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { encodeFrame, FrameDecoder } from '@arsumbris/au-engine-sdk'

import { connectHostRelayClient, hostSocketPath, hostAvailable } from '../src/host-client.ts'
import type { HostRequestFrame, HostResponseFrame } from '../src/host-protocol.ts'
import { intentTools } from '../src/intent-tools.ts'
import type { PluginBroker } from '@arsumbris/au-mcp-sdk'
import type { CallableResult } from '@arsumbris/au-mcp-sdk'

// A fake host server bound at the workspace's derived host socket path. `reply`
// maps a request frame to a response frame; return `null` to send nothing (a
// wedged host, for the timeout path).
type ReplyFn = (req: HostRequestFrame) => HostResponseFrame | HostResponseFrame[] | null

async function startFakeHost(entry: string, reply: ReplyFn): Promise<net.Server> {
  const sockPath = hostSocketPath(entry)
  await mkdir(dirname(sockPath), { recursive: true })
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder()
    socket.on('data', (chunk: Buffer) => {
      for (const value of decoder.push(chunk)) {
        const out = reply(value as HostRequestFrame)
        if (out === null) continue
        for (const frame of Array.isArray(out) ? out : [out]) socket.write(encodeFrame(frame))
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(sockPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  return server
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function tempWorkspace(): Promise<string> {
  // Isolate HOME so the host socket lands in a temp dir, not the real ~/.arsumbris.
  // MUST be short: the socket path lives under HOME, and a Unix socket path over
  // ~104 bytes (macOS SUN_LEN) makes `listen` fail — the exact reason the real
  // sockets live under $HOME, not deep in the repo. tmpdir() on macOS is already
  // a long `/var/folders/...` path, so anchor at `/tmp` instead.
  const home = await mkdtemp('/tmp/auh-')
  const prevHome = process.env.HOME
  process.env.HOME = home
  cleanups.push(() => {
    process.env.HOME = prevHome
  })
  const ws = await mkdtemp(join(tmpdir(), 'au-mcp-host-ws-'))
  cleanups.push(() => rm(ws, { recursive: true, force: true }))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  return ws
}

describe('hostSocketPath', () => {
  it('derives $HOME/.arsumbris/au-host/run/<hash>.host.sock, sharing the engine hash', async () => {
    const ws = await tempWorkspace()
    const p = hostSocketPath(ws)
    expect(p).toMatch(/\.arsumbris\/au-host\/run\/[0-9a-f]{16}\.host\.sock$/)
    expect(p.startsWith(process.env.HOME!)).toBe(true)
  })

  it('hostAvailable reflects socket presence', async () => {
    const ws = await tempWorkspace()
    expect(hostAvailable(ws)).toBe(false)
    const server = await startFakeHost(ws, () => null)
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())))
    expect(hostAvailable(ws)).toBe(true)
  })
})

describe('connectHostRelayClient', () => {
  it('round-trips a fireIntent command and returns the result', async () => {
    const ws = await tempWorkspace()
    const server = await startFakeHost(ws, (req) => ({
      id: req.id,
      ok: true,
      result: { command: 'fireIntent', claimed: true },
    }))
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())))

    const client = await connectHostRelayClient(ws)
    cleanups.push(() => client.close())
    const result = await client.send({ command: 'fireIntent', intent: { type: 'ui-intent-highlight' } })
    expect(result).toEqual({ command: 'fireIntent', claimed: true })
  })

  it('correlates replies by id even when the host answers out of order', async () => {
    const ws = await tempWorkspace()
    // Buffer both requests, then reply to the SECOND before the FIRST.
    const buffered: HostResponseFrame[] = []
    const server = await startFakeHost(ws, (req) => {
      const claimed = req.request.command === 'fireIntent' // distinguish the two
      buffered.push({ id: req.id, ok: true, result: { command: 'fireIntent', claimed } })
      if (buffered.length < 2) return null
      return buffered.reverse() // second first
    })
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())))

    const client = await connectHostRelayClient(ws)
    cleanups.push(() => client.close())
    const [a, b] = await Promise.all([
      client.send({ command: 'fireIntent', intent: { type: 'a' } }),
      client.send({ command: 'introspect' }),
    ])
    expect(a).toEqual({ command: 'fireIntent', claimed: true }) // the fireIntent
    expect(b).toEqual({ command: 'fireIntent', claimed: false }) // the introspect's frame
  })

  it('surfaces an ok:false command failure as a rejection', async () => {
    const ws = await tempWorkspace()
    const server = await startFakeHost(ws, (req) => ({ id: req.id, ok: false, error: 'no handler mounted' }))
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())))

    const client = await connectHostRelayClient(ws)
    cleanups.push(() => client.close())
    await expect(client.send({ command: 'introspect' })).rejects.toThrow('no handler mounted')
  })

  it('rejects the connect when no host is serving', async () => {
    const ws = await tempWorkspace()
    await expect(connectHostRelayClient(ws, { retries: 1, retryDelayMs: 10 })).rejects.toThrow(/unreachable/)
  })

  it('rejects a pending send when the socket closes mid-flight', async () => {
    const ws = await tempWorkspace()
    // Server accepts, never replies, then drops the connection.
    const server = await startFakeHost(ws, () => null)
    server.on('connection', (socket) => setTimeout(() => socket.destroy(), 20))
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())))

    const client = await connectHostRelayClient(ws)
    cleanups.push(() => client.close())
    await expect(client.send({ command: 'introspect' })).rejects.toThrow(/closed/)
  })
})

describe('au_host_snapshot (introspect over the relay)', () => {
  it('returns the live composition tree + focus from a running host', async () => {
    const ws = await tempWorkspace()
    const snapshot = {
      root: {
        id: 'root',
        projection: 'bento',
        kinds: ['container-projection'],
        handles: ['open-intent'],
        children: [{ id: 'ed1', projection: 'editor', kinds: ['pane-projection'], handles: ['ui-intent-highlight'], children: [] }],
      },
      focus: { activeNodeId: 'ed1' },
    }
    const server = await startFakeHost(ws, (req) =>
      req.request.command === 'introspect'
        ? { id: req.id, ok: true, result: { command: 'introspect', snapshot } }
        : { id: req.id, ok: false, error: 'unexpected command' },
    )
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())))

    const broker: PluginBroker = { available: () => true, read: async () => ({}), mutate: async () => ({}) }
    const plugin = intentTools(broker, ws).find((p) => p.manifest.id === 'mcp.au_host_snapshot')!
    const res = (await plugin.invoke!({})) as CallableResult
    expect(res.isError).toBeUndefined()
    const content = res.content as { host_present: boolean; root: typeof snapshot.root; focus: typeof snapshot.focus }
    expect(content.host_present).toBe(true)
    expect(content.root.id).toBe('root')
    expect(content.root.children[0].handles).toContain('ui-intent-highlight')
    expect(content.focus.activeNodeId).toBe('ed1')
  })
})

describe('au_host_pane_op (containerOp over the relay)', () => {
  it('relays activate and returns the outcome from a running host', async () => {
    const ws = await tempWorkspace()
    let received: unknown
    const server = await startFakeHost(ws, (req) => {
      if (req.request.command !== 'containerOp') return { id: req.id, ok: false, error: 'unexpected command' }
      received = req.request.op
      return { id: req.id, ok: true, result: { command: 'containerOp', outcome: { done: true } } }
    })
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())))

    const broker: PluginBroker = { available: () => true, read: async () => ({}), mutate: async () => ({}) }
    const plugin = intentTools(broker, ws).find((p) => p.manifest.id === 'mcp.au_host_pane_op')!
    const res = (await plugin.invoke!({ op: 'activate', paneId: 'ed1' })) as CallableResult
    expect(res.isError).toBeUndefined()
    expect(res.content).toEqual({ done: true })
    expect(received).toEqual({ op: 'activate', paneId: 'ed1' }) // verb + params threaded to the wire
  })
})
