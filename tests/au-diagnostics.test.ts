// au_diagnostics as a LOADABLE plugin — ported from au-mcp's plugins.test.ts as the tool
// moved out of the kernel (plan 2608261532 Phase 2). Same behaviour, exercised through the
// createPlugin(ctx) -> { invoke } shape over a mock PluginBroker (no in-process privilege).

import { describe, it, expect } from 'vitest'
import type { PluginBroker, CallableResult } from '@arsumbris/au-mcp-sdk'
import { createPlugin } from '../src/tool-au-diagnostics.ts'

type Call = { op: string; args: Record<string, unknown> }
const diagBroker = (counts: unknown, page: unknown[], calls: Call[] = []): PluginBroker => ({
  available: () => true,
  mutate: async () => ({}),
  read: async (op, args = {}) => {
    calls.push({ op, args })
    if (op === 'diagnostic_counts') return { type: 'response', ready: true, result: counts }
    if (op === 'diagnostics') return { type: 'response', ready: true, result: page }
    return { type: 'response', ready: true, result: null }
  },
})
const invoke = (b: PluginBroker) => createPlugin({ workspace: '/x', broker: b }).invoke!

describe('au_diagnostics (loadable plugin)', () => {
  it('returns a full-scope summary + an errors-by-default page', async () => {
    const calls: Call[] = []
    const counts = { total: 92, by_severity: { error: 13, warning: 79 }, by_code: { 'navigational-target-not-found': 79 } }
    const page = Array.from({ length: 13 }, (_, i) => ({ code: 'x', severity: 'error', message: `e${i}` }))
    const res = (await invoke(diagBroker(counts, page, calls))({})) as CallableResult
    const c = res.content as Record<string, unknown>
    expect(c.summary).toEqual(counts) // summary spans every severity
    expect(c.severity).toBe('error') // page defaulted to errors
    expect(c.diagnostics).toHaveLength(13)
    // the page read got severity:error injected; the counts read stayed unfiltered (full scope)
    expect(calls.find((x) => x.op === 'diagnostics')!.args.severity).toBe('error')
    expect(calls.find((x) => x.op === 'diagnostic_counts')!.args.severity).toBeUndefined()
  })

  it('honors an explicit severity for the page', async () => {
    const calls: Call[] = []
    const res = (await invoke(diagBroker({ total: 5 }, [], calls))({ severity: 'warning' })) as CallableResult
    expect((res.content as Record<string, unknown>).severity).toBe('warning')
    expect(calls.find((x) => x.op === 'diagnostics')!.args.severity).toBe('warning')
  })

  it('signals truncation when the page fills limit', async () => {
    const page = Array.from({ length: 50 }, () => ({ severity: 'error' }))
    const res = (await invoke(diagBroker({ total: 200 }, page))({})) as CallableResult
    const c = res.content as Record<string, unknown>
    expect(c.truncated).toBe(true)
    expect(c.next_offset).toBe(50)
  })

  it('clamps a bad limit to the default', async () => {
    const calls: Call[] = []
    await invoke(diagBroker({ total: 0 }, [], calls))({ limit: 0 })
    expect(calls.find((x) => x.op === 'diagnostics')!.args.limit).toBe(50)
  })

  it('fails cleanly when no engine is reachable', async () => {
    const noEngine: PluginBroker = { available: () => false, read: async () => ({}), mutate: async () => ({}) }
    const res = (await invoke(noEngine)({})) as CallableResult
    expect(res.isError).toBe(true)
  })
})
