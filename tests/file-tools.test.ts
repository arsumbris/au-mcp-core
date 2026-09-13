// File-op plugins — MOVED from au-mcp's plugins.test.ts as the file tools migrated to au-mcp-core
// (plan 2608261532 Phase 3). Bodies unchanged (file-tools.ts still exports fileTools()); the broker
// type is the SDK's PluginBroker (was EngineBroker), socketPath mock props dropped. The three shared
// helpers (tempWorkspace / invokeOf / contentBroker) are copied here — they stay in au-mcp too, used
// by the daemon-loads + intent test blocks that remain there.

import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginBroker, CallableResult } from '@arsumbris/au-mcp-sdk'
import { fileTools } from '../src/file-tools.ts'

async function tempWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'au-mcp-plug-'))
  await mkdir(join(ws, '.arsumbris'), { recursive: true })
  return ws
}

function invokeOf(plugins: ReturnType<typeof fileTools>, id: string) {
  const plugin = plugins.find((p) => p.manifest.id === id)
  if (!plugin?.invoke) throw new Error(`no tool ${id}`)
  return (input: unknown) => plugin.invoke!(input) as Promise<CallableResult>
}

// A broker whose `content` read mirrors the engine: read the file off disk,
// return { content, hash } ([[decision - 2606251052 ...]] — read_file_pinned routes here).
const contentBroker = (): PluginBroker => ({
  available: () => true,
  mutate: async () => ({}),
  read: async (op, args = {}) => {
    if (op !== 'content') return {}
    try {
      const text = await readFile(String(args.path), 'utf8')
      return { type: 'response', ready: true, result: { text, hash: 'h-test' } }
    } catch {
      return { type: 'response', ready: true, result: null }
    }
  },
})

describe('file-op plugins', () => {
  it('read_file_pinned returns cat -n numbered lines (via the engine content read)', async () => {
    const ws = await tempWorkspace()
    const file = join(ws, 'hello.txt')
    await writeFile(file, 'alpha\nbeta\ngamma\n')
    const read = invokeOf(fileTools(ws, contentBroker()), 'mcp.read_file_pinned')
    const res = await read({ file_path: file })
    expect(res.isError).toBeUndefined()
    expect(res.content).toBe('     1\talpha\n     2\tbeta\n     3\tgamma')
  })

  it('read_file_pinned rejects a relative path', async () => {
    const ws = await tempWorkspace()
    const read = invokeOf(fileTools(ws, contentBroker()), 'mcp.read_file_pinned')
    const res = await read({ file_path: 'rel.txt' })
    expect(res.isError).toBe(true)
  })

  it('read_file_pinned refuses with no engine (reads require the engine, like writes)', async () => {
    const ws = await tempWorkspace()
    const read = invokeOf(fileTools(ws), 'mcp.read_file_pinned')
    const res = await read({ file_path: join(ws, 'x.txt') })
    expect(res.isError).toBe(true)
    expect(String(res.content)).toMatch(/no engine/)
  })

  it('write_file routes through the engine mutation channel (expected_hash CAS)', async () => {
    const ws = await tempWorkspace()
    const file = join(ws, 'sub', 'note.md')
    const calls: { verb: string; args: Record<string, unknown> }[] = []
    const broker: PluginBroker = {
      available: () => true,
      read: async () => ({}),
      mutate: async (verb, args = {}) => {
        calls.push({ verb, args })
        return { type: 'response', ready: true, result: { hash: 'h2', commit: 'c0ffee' } }
      },
    }
    const write = invokeOf(fileTools(ws, broker), 'mcp.write_file')
    const res = await write({ file_path: file, content: 'one two two', expected_hash: 'h1' })
    expect(res.isError).toBeUndefined()
    expect(calls).toEqual([{ verb: 'write_file', args: { path: file, content: 'one two two', expected_hash: 'h1' } }])
    // Result is now structured: a human message (carries the hash) + the touched-file pin
    // material (repo-relative path + the mutation's commit), which the adapter lifts into
    // the trace's `target`.
    const content = res.content as { message: string; touched: { path: string; commit?: string; access?: string } }
    expect(content.message).toContain('h2')
    // A write's touch carries the default direction so the adapter forwards it (no hardcode).
    expect(content.touched).toEqual({ path: join('sub', 'note.md'), commit: 'c0ffee', access: 'write' })
  })

  it('edit_file routes through the channel and surfaces the engine reject verbatim', async () => {
    const ws = await tempWorkspace()
    const file = join(ws, 'note.md')
    const broker: PluginBroker = {
      available: () => true,
      read: async () => ({}),
      mutate: async () => ({ type: 'error', message: 'old_string not found in the file — re-read and retry' }),
    }
    const edit = invokeOf(fileTools(ws, broker), 'mcp.edit_file')
    const res = await edit({ file_path: file, old_string: 'x', new_string: 'y' })
    expect(res.isError).toBe(true)
    expect(String(res.content)).toMatch(/re-read and retry/)
  })

  it('mutations refuse when no engine is reachable (no fs fallback)', async () => {
    const ws = await tempWorkspace()
    const write = invokeOf(fileTools(ws), 'mcp.write_file')
    const res = await write({ file_path: join(ws, 'x.md'), content: 'hi' })
    expect(res.isError).toBe(true)
    expect(String(res.content)).toMatch(/no engine/)
  })

  it('the path guard refuses writes under operations/ and .claude/', async () => {
    const ws = await tempWorkspace()
    const write = invokeOf(fileTools(ws), 'mcp.write_file')
    const ops = await write({ file_path: join(ws, 'operations', 'x.jsonl'), content: 'no' })
    expect(ops.isError).toBe(true)
    expect(String(ops.content)).toMatch(/operations/)
    const dotClaude = await write({ file_path: join(ws, '.claude', 'settings.json'), content: 'no' })
    expect(dotClaude.isError).toBe(true)
    expect(String(dotClaude.content)).toMatch(/\.claude/)
  })

  it('delete_file routes through the mutation channel (expected_hash guard), path-guarded, refuses with no engine', async () => {
    const ws = await tempWorkspace()
    const file = join(ws, 'gone.md')
    const calls: { verb: string; args: Record<string, unknown> }[] = []
    const broker: PluginBroker = {
      available: () => true,
      read: async () => ({}),
      mutate: async (verb, args = {}) => {
        calls.push({ verb, args })
        // A delete result carries BOTH commits: `commit` = the DELETION commit (attribution),
        // `last_live_commit` = the parent where the file still existed (the readable tombstone pin).
        return { type: 'response', ready: true, result: { hash: null, commit: 'de1e7e', last_live_commit: 'l1ve' } }
      },
    }
    const del = invokeOf(fileTools(ws, broker), 'mcp.delete_file')
    const res = await del({ file_path: file, expected_hash: 'h1' })
    expect(res.isError).toBeUndefined()
    expect(calls).toEqual([{ verb: 'delete_file', args: { path: file, expected_hash: 'h1' } }])
    // The touch stamps the delete DIRECTION (was mislabeled 'write' before) so the adapter
    // forwards `access: 'delete'` without classifying the tool name.
    const delTouch = (res.content as { touched: { access?: string; commit?: string; priorCommit?: string } }).touched
    expect(delTouch.access).toBe('delete')
    // BOTH commits ride the touch: `commit` (deletion, attribution) + `priorCommit` (last-live,
    // the readable tombstone pin the adapter builds `target` from via pinnedFileTarget).
    expect(delTouch.commit).toBe('de1e7e')
    expect(delTouch.priorCommit).toBe('l1ve')
    // path guard + no-engine refusal, like write/edit.
    expect((await del({ file_path: join(ws, '.claude', 'x') })).isError).toBe(true)
    expect((await invokeOf(fileTools(ws), 'mcp.delete_file')({ file_path: file })).isError).toBe(true)
  })

  it('the stampable write tools forward a daemon-injected stamp to the mutation channel', async () => {
    const ws = await tempWorkspace()
    const file = join(ws, 'note.md')
    const calls: { verb: string; args: Record<string, unknown> }[] = []
    const broker: PluginBroker = {
      available: () => true,
      read: async () => ({}),
      mutate: async (verb, args = {}) => {
        calls.push({ verb, args })
        return { type: 'response', ready: true, result: { hash: 'h', commit: 'c' } }
      },
    }
    const tools = fileTools(ws, broker)
    // The stamps LIST arrives on the tool INPUT (the daemon injected it there); the tool forwards it
    // as `args.stamps` to broker.mutate. It is NOT an agent-facing field — the tool only relays it.
    const stamps = [{ field: 'spine', record: { type: 'fc.edit', session: 's1' }, matchOn: { type: 'fc.edit' } }]
    await invokeOf(tools, 'mcp.write_file')({ file_path: file, content: 'x', stamps })
    expect(calls.at(-1)!.args.stamps).toEqual(stamps)
    await invokeOf(tools, 'mcp.edit_file')({ file_path: file, old_string: 'a', new_string: 'b', stamps })
    expect(calls.at(-1)!.args.stamps).toEqual(stamps)
    await invokeOf(tools, 'mcp.rename')({ file_path: file, to: join(ws, 'moved.md'), stamps })
    expect(calls.at(-1)!.args.stamps).toEqual(stamps)
    // a write carrying no stamps forwards none.
    await invokeOf(tools, 'mcp.write_file')({ file_path: file, content: 'y' })
    expect('stamps' in calls.at(-1)!.args).toBe(false)
  })

  it('assign_block_id passes the byte offset and surfaces the engine id + ref', async () => {
    const ws = await tempWorkspace()
    const file = join(ws, 'note.md')
    const calls: { verb: string; args: Record<string, unknown> }[] = []
    const broker: PluginBroker = {
      available: () => true,
      read: async () => ({}),
      mutate: async (verb, args = {}) => {
        calls.push({ verb, args })
        return { type: 'response', ready: true, result: { hash: 'h9', commit: 'c1', id: 'b-7', ref: '[[note^b-7]]' } }
      },
    }
    const assign = invokeOf(fileTools(ws, broker), 'mcp.assign_block_id')
    expect((await assign({ file_path: file })).isError).toBe(true) // at required
    expect((await assign({ file_path: file, at: -1 })).isError).toBe(true) // non-negative
    const res = await assign({ file_path: file, at: 42 })
    expect(calls).toEqual([{ verb: 'assign_block_id', args: { path: file, at: 42 } }])
    const content = res.content as { id?: string; ref?: string; message: string }
    expect(content.id).toBe('b-7')
    expect(content.ref).toBe('[[note^b-7]]')
    expect(content.message).toContain('[[note^b-7]]')
  })

  it('rename routes to the mutation channel with path+to, guards both paths, surfaces the reject verbatim', async () => {
    const ws = await tempWorkspace()
    const from = join(ws, 'old.md')
    const to = join(ws, 'sub', 'new.md')
    const calls: { verb: string; args: Record<string, unknown> }[] = []
    const broker: PluginBroker = {
      available: () => true,
      read: async () => ({}),
      mutate: async (verb, args = {}) => {
        calls.push({ verb, args })
        return { type: 'response', ready: true, result: { path: to, hash: 'h3', commit: 'ca11' } }
      },
    }
    const rename = invokeOf(fileTools(ws, broker), 'mcp.rename')
    expect((await rename({ file_path: from })).isError).toBe(true) // to required
    const res = await rename({ file_path: from, to })
    expect(calls).toEqual([{ verb: 'rename', args: { path: from, to } }])
    // touched follows the NEW location (result.path == to); it stamps the rename direction
    // and carries the OLD path as `from`, so the name-history edge rides stamped fields.
    expect((res.content as { touched: { path: string; access?: string; from?: string } }).touched).toMatchObject({
      path: join('sub', 'new.md'),
      access: 'rename',
      from: 'old.md',
    })
    // path guard applies to the destination too.
    expect((await rename({ file_path: from, to: join(ws, '.claude', 'x.md') })).isError).toBe(true)
    // a reject frame surfaces verbatim.
    const rejBroker: PluginBroker = { available: () => true, read: async () => ({}), mutate: async () => ({ type: 'error', message: 'destination already exists: new.md' }) }
    const rej = await invokeOf(fileTools(ws, rejBroker), 'mcp.rename')({ file_path: from, to })
    expect(rej.isError).toBe(true)
    expect(String(rej.content)).toMatch(/already exists/)
  })

  it('rename_type takes type names (no file path) and reads the moved def path off the result', async () => {
    const ws = await tempWorkspace()
    const movedDef = join(ws, 'type', 'widget.type.yaml')
    const calls: { verb: string; args: Record<string, unknown> }[] = []
    const broker: PluginBroker = {
      available: () => true,
      read: async () => ({}),
      mutate: async (verb, args = {}) => {
        calls.push({ verb, args })
        return { type: 'response', ready: true, result: { path: movedDef, hash: 'h4', commit: 'de5' } }
      },
    }
    const renameType = invokeOf(fileTools(ws, broker), 'mcp.rename_type')
    expect((await renameType({ old_name: 'gadget' })).isError).toBe(true) // new_name required
    const res = await renameType({ old_name: 'gadget', new_name: 'widget' })
    expect(calls).toEqual([{ verb: 'rename_type', args: { old_name: 'gadget', new_name: 'widget' } }])
    // touched derives from result.path (the tool had no input file path).
    expect((res.content as { touched: { path: string } }).touched.path).toBe(join('type', 'widget.type.yaml'))
    // refuses with no engine.
    expect((await invokeOf(fileTools(ws), 'mcp.rename_type')({ old_name: 'a', new_name: 'b' })).isError).toBe(true)
  })

  it('promote requires exactly one locator (at XOR block_id) and forwards it', async () => {
    const ws = await tempWorkspace()
    const host = join(ws, 'host.md')
    const to = join(ws, 'extracted.md')
    const calls: { verb: string; args: Record<string, unknown> }[] = []
    const broker: PluginBroker = {
      available: () => true,
      read: async () => ({}),
      mutate: async (verb, args = {}) => { calls.push({ verb, args }); return { type: 'response', ready: true, result: { path: to, hash: 'h5', commit: 'c2' } } },
    }
    const promote = invokeOf(fileTools(ws, broker), 'mcp.promote')
    expect((await promote({ file_path: host, to })).isError).toBe(true) // neither locator
    expect((await promote({ file_path: host, to, at: 10, block_id: 'b-1' })).isError).toBe(true) // both
    await promote({ file_path: host, to, block_id: 'b-1' })
    expect(calls.at(-1)).toEqual({ verb: 'promote', args: { path: host, to, block_id: 'b-1' } })
    await promote({ file_path: host, to, at: 12 })
    expect(calls.at(-1)).toEqual({ verb: 'promote', args: { path: host, to, at: 12 } })
  })

  it('inline forwards path+into and optional at; guards both paths', async () => {
    const ws = await tempWorkspace()
    const foldee = join(ws, 'foldee.md')
    const into = join(ws, 'host.md')
    const calls: { verb: string; args: Record<string, unknown> }[] = []
    const broker: PluginBroker = {
      available: () => true,
      read: async () => ({}),
      mutate: async (verb, args = {}) => { calls.push({ verb, args }); return { type: 'response', ready: true, result: { path: into, hash: 'h6', commit: 'c3' } } },
    }
    const inline = invokeOf(fileTools(ws, broker), 'mcp.inline')
    expect((await inline({ file_path: foldee })).isError).toBe(true) // into required
    await inline({ file_path: foldee, into })
    expect(calls.at(-1)).toEqual({ verb: 'inline', args: { path: foldee, into } })
    await inline({ file_path: foldee, into, at: 5 })
    expect(calls.at(-1)).toEqual({ verb: 'inline', args: { path: foldee, into, at: 5 } })
    expect((await inline({ file_path: foldee, into: join(ws, '.claude', 'x') })).isError).toBe(true) // guard
  })

  it('rename_block_id forwards path+block_id+to_block_id', async () => {
    const ws = await tempWorkspace()
    const host = join(ws, 'host.md')
    const calls: { verb: string; args: Record<string, unknown> }[] = []
    const broker: PluginBroker = {
      available: () => true,
      read: async () => ({}),
      mutate: async (verb, args = {}) => { calls.push({ verb, args }); return { type: 'response', ready: true, result: { path: host, hash: 'h7', commit: 'c4' } } },
    }
    const rbi = invokeOf(fileTools(ws, broker), 'mcp.rename_block_id')
    expect((await rbi({ file_path: host, block_id: 'b-1' })).isError).toBe(true) // to_block_id required
    await rbi({ file_path: host, block_id: 'b-1', to_block_id: 'b-2' })
    expect(calls.at(-1)).toEqual({ verb: 'rename_block_id', args: { path: host, block_id: 'b-1', to_block_id: 'b-2' } })
  })

  it('bash is a signal-capturing stub — it does not execute, returns guidance, never errors', async () => {
    // [[decision - 2606250955 - the cage bash tool becomes a signal-capturing stub]]:
    // bash stays advertised (the reach + command are traced) but does NOT run the
    // shell. It returns `ok` guidance, not the command's stdout/exit code.
    const ws = await tempWorkspace()
    const bash = invokeOf(fileTools(ws), 'mcp.bash')
    const res = await bash({ command: 'echo bashstub-ran && pwd' })
    expect(res.isError).toBeUndefined()
    // the command did NOT run: no stdout echo, no exit-code line, no cwd path.
    expect(String(res.content)).not.toContain('bashstub-ran')
    expect(String(res.content)).not.toMatch(/exit code/)
    expect(String(res.content)).not.toContain(ws)
    // it points the agent at the typed gate tools + asks what it needed.
    expect(String(res.content)).toMatch(/not available/)
    expect(String(res.content)).toMatch(/au_/)
  })

  describe('grep_files modes', () => {
    async function grepWs(): Promise<string> {
      const ws = await tempWorkspace()
      await writeFile(join(ws, 'a.md'), 'needle here\nother\nneedle again\n')
      await writeFile(join(ws, 'b.md'), 'nothing\nNEEDLE upper\n')
      return ws
    }
    const grep = (ws: string) => invokeOf(fileTools(ws), 'mcp.grep_files')

    it("requires `query` (the renamed param; `pattern` is gone)", async () => {
      const ws = await grepWs()
      expect((await grep(ws)({ pattern: 'needle' })).isError).toBe(true)
      expect((await grep(ws)({ query: 'needle' })).isError).toBeUndefined()
    })

    it('content mode (default): path:line:match, case-insensitive', async () => {
      const ws = await grepWs()
      const res = await grep(ws)({ query: 'needle' })
      const text = String(res.content)
      expect(text).toMatch(/a\.md:1:needle here/)
      expect(text).toMatch(/a\.md:3:needle again/)
      expect(text).toMatch(/b\.md:2:NEEDLE upper/) // case-insensitive by default
    })

    it('files mode: matching paths only, deduped', async () => {
      const ws = await grepWs()
      const text = String((await grep(ws)({ query: 'needle', mode: 'files' })).content)
      const lines = text.split('\n').filter(Boolean)
      expect(lines.every((l) => l.endsWith('a.md') || l.endsWith('b.md'))).toBe(true)
      expect(lines).toHaveLength(2) // a.md once despite two matches
      expect(text).not.toMatch(/:\d+:/) // no line:content
    })

    it('count mode: path:count per file', async () => {
      const ws = await grepWs()
      const text = String((await grep(ws)({ query: 'needle', mode: 'count' })).content)
      expect(text).toMatch(/a\.md:2/)
      expect(text).toMatch(/b\.md:1/)
    })

    it('content mode truncates a long line (the token-overflow fix)', async () => {
      const ws = await tempWorkspace()
      await writeFile(join(ws, 'long.md'), `start ${'x'.repeat(5000)} needle end\n`)
      const text = String((await grep(ws)({ query: 'needle', max_line_length: 40 })).content)
      expect(text).toMatch(/…\[\+\d+ chars\]/)
      expect(text.split('\n')[0].length).toBeLessThan(120)
    })

    it('paginates with limit + offset (the footer reports the next page)', async () => {
      const ws = await tempWorkspace()
      await writeFile(join(ws, 'many.md'), Array.from({ length: 20 }, (_, i) => `needle ${i}`).join('\n'))
      const matchLines = (t: string) => t.split('\n').filter((l) => /many\.md:/.test(l))

      const page1 = String((await grep(ws)({ query: 'needle', limit: 5 })).content)
      expect(matchLines(page1)).toHaveLength(5)
      expect(page1).toMatch(/showing 1.5 of 20; use offset=5 for the next page/) // `.` = en-dash

      const page2 = String((await grep(ws)({ query: 'needle', limit: 5, offset: 5 })).content)
      expect(matchLines(page2)).toHaveLength(5)
      expect(page2).toMatch(/showing 6.10 of 20; use offset=10 for the next page/)
      expect(page2).toMatch(/many\.md:6:needle 5/) // page 2 starts at the 6th match (line 6)

      const last = String((await grep(ws)({ query: 'needle', limit: 5, offset: 15 })).content)
      expect(last).toMatch(/showing 16.20 of 20/)
      expect(last).not.toMatch(/next page/) // no more

      const beyond = String((await grep(ws)({ query: 'needle', offset: 99 })).content)
      expect(beyond).toMatch(/No matches at offset 99 \(of 20 total\)/)
    })

    it('rejects an unknown mode', async () => {
      const ws = await grepWs()
      expect((await grep(ws)({ query: 'needle', mode: 'bogus' })).isError).toBe(true)
    })
  })
})

describe('write-bump — a governed write reports a readViewUpdate (session freshness)', () => {
  const mutBroker = (): PluginBroker => ({
    available: () => true,
    read: async () => ({}),
    mutate: async (_verb, args = {}) => ({
      type: 'response',
      ready: true,
      result: { path: args.path ?? args.to, hash: 'h-new', commit: null },
    }),
  })

  it('write_file sets the written path to the post-write hash', async () => {
    const ws = await tempWorkspace()
    const file = join(ws, 'a.md')
    const res = await invokeOf(fileTools(ws, mutBroker()), 'mcp.write_file')({ file_path: file, content: 'x' })
    expect(res.readViewUpdate).toEqual({ set: { path: file, hash: 'h-new' } })
  })

  it('delete_file removes the deleted path (no set)', async () => {
    const ws = await tempWorkspace()
    const file = join(ws, 'a.md')
    const res = await invokeOf(fileTools(ws, mutBroker()), 'mcp.delete_file')({ file_path: file })
    expect(res.readViewUpdate).toEqual({ remove: [file] })
  })

  it('rename sets the destination and removes the source', async () => {
    const ws = await tempWorkspace()
    const from = join(ws, 'a.md')
    const to = join(ws, 'b.md')
    const res = await invokeOf(fileTools(ws, mutBroker()), 'mcp.rename')({ file_path: from, to })
    expect(res.readViewUpdate).toEqual({ set: { path: to, hash: 'h-new' }, remove: [from] })
  })
})
