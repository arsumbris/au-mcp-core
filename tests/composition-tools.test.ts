// Composition mutation plugins — author a repo's deps: (.arsumbris/repo.yaml) or a
// workspace's edit:/discover: membership (.arsumbris/workspace.yaml) through the engine
// mutation channel. The five verbs mirror the au-engine-sdk DaemonClient composition
// methods (au-engine message 260914224057). Each forwards to broker.mutate(<verb>, args)
// and surfaces the engine's reject verbatim; with no engine they refuse.

import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginBroker, CallableResult } from '@arsumbris/au-mcp-sdk'
import { compositionTools } from '../src/composition-tools.ts'

async function tempWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'au-mcp-comp-'))
  await mkdir(join(ws, '.arsumbris'), { recursive: true })
  return ws
}

function invokeOf(plugins: ReturnType<typeof compositionTools>, id: string) {
  const plugin = plugins.find((p) => p.manifest.id === id)
  if (!plugin?.invoke) throw new Error(`no tool ${id}`)
  return (input: unknown) => plugin.invoke!(input) as Promise<CallableResult>
}

// A broker recording every mutation call, returning the standard mutate envelope.
function recordingBroker(): { broker: PluginBroker; calls: { verb: string; args: Record<string, unknown> }[] } {
  const calls: { verb: string; args: Record<string, unknown> }[] = []
  const broker: PluginBroker = {
    available: () => true,
    read: async () => ({}),
    mutate: async (verb, args = {}) => {
      calls.push({ verb, args })
      return { type: 'response', ready: true, result: { hash: 'h-comp', commit: 'c0de' } }
    },
  }
  return { broker, calls }
}

describe('composition mutation plugins', () => {
  it('declares read-write access on every composition tool', async () => {
    const ws = await tempWorkspace()
    const tools = compositionTools(ws, recordingBroker().broker)
    expect(tools).toHaveLength(5)
    for (const t of tools) {
      expect(t.manifest.kind === 'tool' && t.manifest.access).toBe('read-write')
    }
  })

  it('add_dep forwards name + optional remote/ref/root, rejects a missing name', async () => {
    const ws = await tempWorkspace()
    const { broker, calls } = recordingBroker()
    const addDep = invokeOf(compositionTools(ws, broker), 'mcp.add_dep')
    expect((await addDep({})).isError).toBe(true) // name required
    const res = await addDep({ name: 'au-widgets', remote: 'git@x:au-widgets.git', ref: 'main', root: 'au-mcp-core' })
    expect(res.isError).toBeUndefined()
    expect(calls).toEqual([
      { verb: 'add_dep', args: { name: 'au-widgets', remote: 'git@x:au-widgets.git', ref: 'main', root: 'au-mcp-core' } },
    ])
    // a bare add forwards only name (no empty optionals).
    await addDep({ name: 'au-plain' })
    expect(calls.at(-1)).toEqual({ verb: 'add_dep', args: { name: 'au-plain' } })
  })

  it('remove_dep forwards name + optional root, rejects a missing name', async () => {
    const ws = await tempWorkspace()
    const { broker, calls } = recordingBroker()
    const removeDep = invokeOf(compositionTools(ws, broker), 'mcp.remove_dep')
    expect((await removeDep({})).isError).toBe(true)
    await removeDep({ name: 'au-widgets', root: 'au-mcp-core' })
    expect(calls.at(-1)).toEqual({ verb: 'remove_dep', args: { name: 'au-widgets', root: 'au-mcp-core' } })
  })

  it('add_workspace_member forwards name + role, rejects a missing/invalid role', async () => {
    const ws = await tempWorkspace()
    const { broker, calls } = recordingBroker()
    const addMember = invokeOf(compositionTools(ws, broker), 'mcp.add_workspace_member')
    expect((await addMember({ name: 'au-widgets' })).isError).toBe(true) // role required
    expect((await addMember({ name: 'au-widgets', role: 'dep' })).isError).toBe(true) // not edit|discover
    await addMember({ name: 'au-widgets', role: 'edit' })
    expect(calls.at(-1)).toEqual({ verb: 'add_workspace_member', args: { name: 'au-widgets', role: 'edit' } })
    await addMember({ name: 'au-fixtures', role: 'discover', root: 'au-mcp-core' })
    expect(calls.at(-1)).toEqual({ verb: 'add_workspace_member', args: { name: 'au-fixtures', role: 'discover', root: 'au-mcp-core' } })
  })

  it('remove_workspace_member forwards name + optional root', async () => {
    const ws = await tempWorkspace()
    const { broker, calls } = recordingBroker()
    const removeMember = invokeOf(compositionTools(ws, broker), 'mcp.remove_workspace_member')
    expect((await removeMember({})).isError).toBe(true)
    await removeMember({ name: 'au-widgets' })
    expect(calls.at(-1)).toEqual({ verb: 'remove_workspace_member', args: { name: 'au-widgets' } })
  })

  it('set_workspace_member_role forwards name + target role, rejects an invalid role', async () => {
    const ws = await tempWorkspace()
    const { broker, calls } = recordingBroker()
    const setRole = invokeOf(compositionTools(ws, broker), 'mcp.set_workspace_member_role')
    expect((await setRole({ name: 'au-widgets' })).isError).toBe(true) // role required
    expect((await setRole({ name: 'au-widgets', role: 'entry' })).isError).toBe(true) // not edit|discover
    await setRole({ name: 'au-widgets', role: 'discover' })
    expect(calls.at(-1)).toEqual({ verb: 'set_workspace_member_role', args: { name: 'au-widgets', role: 'discover' } })
  })

  it('surfaces the engine reject verbatim (a duplicate / non-editable member)', async () => {
    const ws = await tempWorkspace()
    const broker: PluginBroker = {
      available: () => true,
      read: async () => ({}),
      mutate: async () => ({ type: 'error', message: "dependency 'au-widgets' already declared" }),
    }
    const res = await invokeOf(compositionTools(ws, broker), 'mcp.add_dep')({ name: 'au-widgets' })
    expect(res.isError).toBe(true)
    expect(String(res.content)).toMatch(/already declared/)
  })

  it('every composition verb refuses when no engine is reachable', async () => {
    const ws = await tempWorkspace()
    const tools = compositionTools(ws) // no broker
    for (const [id, input] of [
      ['mcp.add_dep', { name: 'x' }],
      ['mcp.remove_dep', { name: 'x' }],
      ['mcp.add_workspace_member', { name: 'x', role: 'edit' }],
      ['mcp.remove_workspace_member', { name: 'x' }],
      ['mcp.set_workspace_member_role', { name: 'x', role: 'edit' }],
    ] as const) {
      const res = await invokeOf(tools, id)(input)
      expect(res.isError).toBe(true)
      expect(String(res.content)).toMatch(/no engine/)
    }
  })
})
