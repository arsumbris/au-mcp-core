// Host-relay intent tools (au_host_intent_fire / au_host_intent_list / au_host_snapshot / au_host_pane_op),
// migrated from au-mcp's plugins.test.ts into au-mcp-core with the tool defs (plan 2608261532).
// Exercises the intentTools() factory directly over mocked PluginBrokers — no daemon, no host app.

import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallableResult, Plugin, PluginBroker } from '@arsumbris/au-mcp-sdk'
import { intentTools, fireErrorMessage } from '../src/intent-tools.ts'

async function tempWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'au-mcp-core-intent-'))
  await mkdir(join(ws, '.arsumbris'), { recursive: true })
  return ws
}

function invokeOf(plugins: Plugin[], id: string) {
  const plugin = plugins.find((p) => p.manifest.id === id)
  if (!plugin?.invoke) throw new Error(`no tool ${id}`)
  return (input: unknown) => plugin.invoke!(input) as Promise<CallableResult>
}

describe('intent tools (host-relay surface)', () => {
  // A broker that can't validate (no engine) — routing/validation skip, best-effort.
  const noEngineBroker = (): PluginBroker => ({
    available: () => false,
    read: async () => ({}),
    mutate: async () => ({}),
  })

  it('au_host_intent_fire requires an intent type', async () => {
    const ws = await tempWorkspace()
    const fire = invokeOf(intentTools(noEngineBroker(), ws), 'mcp.au_host_intent_fire')
    const res = await fire({ payload: {} })
    expect(res).toMatchObject({ isError: true })
    expect(String((res as { content: unknown }).content)).toMatch(/intent.*required/i)
  })

  it('au_host_intent_fire degrades cleanly when no host is running', async () => {
    const ws = await tempWorkspace() // no host socket for this workspace
    const fire = invokeOf(intentTools(noEngineBroker(), ws), 'mcp.au_host_intent_fire')
    const res = await fire({ intent: 'open-intent', payload: { mode: 'transient' } })
    expect(res).toMatchObject({ isError: true })
    expect(String((res as { content: unknown }).content)).toMatch(/no host is running/i)
  })

  // A broker whose `type` read returns the ui-intent-highlight def (required
  // target + mode, with docstrings + routing), and validate_value passes.
  const highlightBroker = (): PluginBroker => ({
    available: () => true,
    mutate: async () => ({}),
    read: async (op, args = {}) => {
      if (op === 'type' && args.name === 'ui-intent-highlight') {
        return {
          type: 'response',
          ready: true,
          result: {
            name: 'ui-intent-highlight',
            repo: 'intent',
            fields: [
              { name: 'target', shape: 'selection::selection&', required: true, doc: 'What to highlight.' },
              { name: 'mode', shape: '[show-if-visible, reveal-if-exists]', required: true, doc: 'passive vs scroll.' },
            ],
            meta_blocks: [{ type_name: 'intent-routing-meta::intent', body: [{ name: 'kind', value: 'broadcast' }] }],
          },
        }
      }
      if (op === 'validate_value') return { type: 'response', ready: true, result: [] }
      return {}
    },
  })

  it('au_host_intent_fire refuses a payload missing required fields (the live-test no-op gap)', async () => {
    const ws = await tempWorkspace()
    const fire = invokeOf(intentTools(highlightBroker(), ws), 'mcp.au_host_intent_fire')
    const res = await fire({ intent: 'ui-intent-highlight' }) // no payload — the exact failing case
    expect(res).toMatchObject({ isError: true })
    const msg = String((res as { content: unknown }).content)
    expect(msg).toMatch(/required field/i)
    expect(msg).toContain('target')
    expect(msg).toContain('mode')
    expect(msg).toMatch(/au_host_intent_list/) // steer to the catalog
  })

  it('au_host_intent_fire accepts a stringified JSON payload (agents reach for strings)', async () => {
    const ws = await tempWorkspace() // no host -> we prove it got PAST the required check
    const fire = invokeOf(intentTools(highlightBroker(), ws), 'mcp.au_host_intent_fire')
    const res = await fire({
      intent: 'ui-intent-highlight',
      payload: '{"target": {"type": "file-selection", "path": "/x.md"}, "mode": "reveal-if-exists"}',
    })
    expect(res).toMatchObject({ isError: true })
    const msg = String((res as { content: unknown }).content)
    expect(msg).not.toMatch(/required field/i) // the string parsed; required fields were found
    expect(msg).toMatch(/no host is running/i) // reached the relay step
  })

  // FAIL-CLOSED (schema 17): the def resolves for the required-field check, but
  // validate_value returns identity:null (owner unmounted) -> the payload validation
  // refuses rather than proceeding. A full, otherwise-valid payload still gets blocked.
  it('au_host_intent_fire refuses fail-closed when validate_value returns a null-identity verdict', async () => {
    const ws = await tempWorkspace()
    const nullIdentityBroker: PluginBroker = {
      available: () => true,
      mutate: async () => ({}),
      read: async (op, args = {}) => {
        if (op === 'type' && args.name === 'ui-intent-highlight') return highlightBroker().read('type', args)
        if (op === 'validate_value') {
          return {
            type: 'response',
            ready: true,
            result: [{ identity: null, diagnostics: [{ code: 'unknown-type-claim', severity: 'error', message: 'not in the type graph' }] }],
          }
        }
        return {}
      },
    }
    const fire = invokeOf(intentTools(nullIdentityBroker, ws), 'mcp.au_host_intent_fire')
    const res = await fire({
      intent: 'ui-intent-highlight',
      payload: { target: { type: 'file-selection', path: '/x.md' }, mode: 'reveal-if-exists' },
    })
    expect(res).toMatchObject({ isError: true })
    const msg = String((res as { content: unknown }).content)
    expect(msg).toMatch(/invalid payload/i)
    expect(msg).toContain('unknown-type-claim')
  })

  // A broker whose `subtypes('intent')` read returns one intent def (full: doc +
  // fields-with-doc + routing meta), like the real engine over a UI workspace.
  const intentBroker = (): PluginBroker => ({
    available: () => true,
    mutate: async () => ({}),
    read: async (op, args = {}) => {
      if (op !== 'subtypes' || args.base !== 'intent') return {}
      return {
        type: 'response',
        ready: true,
        result: {
          base: 'intent',
          subtypes: [
            {
              name: 'ui-intent-highlight',
              repo: 'intent',
              doc: 'Highlight this element wherever it is shown.',
              fields: [
                { name: 'target', shape: 'selection::selection&', required: true, doc: 'What to highlight (a selection).' },
                { name: 'mode', shape: '[show-if-visible, reveal-if-exists]', required: true, doc: 'passive vs scroll-into-view.' },
              ],
              meta_blocks: [
                { type_name: 'intent-routing-meta::intent', body: [{ name: 'kind', value: 'broadcast' }] },
                // Firable, and declared `::repo`-qualified — the reader must match BARE.
                { type_name: 'intent-agent-meta::intent', body: [{ name: 'firable', value: true }] },
              ],
            },
            {
              // No `intent-agent-meta` block -> NOT firable (default-deny, like promote-intent).
              name: 'promote-intent',
              repo: 'intent',
              doc: 'Promote the firer.',
              fields: [],
              meta_blocks: [{ type_name: 'intent-routing-meta::intent', body: [{ name: 'kind', value: 'routed' }] }],
            },
          ],
        },
      }
    },
  })

  it('au_host_intent_list builds the catalog from subtypes (doc + payload + routing + agent_firable), no host', async () => {
    const ws = await tempWorkspace() // no host socket -> static catalog only
    const list = invokeOf(intentTools(intentBroker(), ws), 'mcp.au_host_intent_list')
    const res = await list({})
    expect(res.isError).toBeUndefined()
    const content = res.content as {
      host_present: boolean
      intents: { intent: string; description?: string; kind?: string; agent_firable: boolean; payload: { name: string; required: boolean; description?: string }[] }[]
    }
    expect(content.host_present).toBe(false)
    expect(content.intents).toHaveLength(2)
    const hl = content.intents.find((i) => i.intent === 'ui-intent-highlight')!
    expect(hl.description).toMatch(/highlight/i)
    expect(hl.kind).toBe('broadcast')
    expect(hl.payload.map((p) => p.name)).toEqual(['target', 'mode'])
    expect(hl.payload[0]).toMatchObject({ required: true })
    expect(hl.payload[0].description).toMatch(/selection/i)
    // FLAGGED, not filtered: the firable one is true (block matched BARE past its `::intent`
    // qualifier), the block-less one is false (default-deny), and BOTH stay in the catalog.
    expect(hl.agent_firable).toBe(true)
    const promote = content.intents.find((i) => i.intent === 'promote-intent')!
    expect(promote.agent_firable).toBe(false)
  })

  it('au_host_intent_list reports empty when no intent vocab is mounted', async () => {
    const ws = await tempWorkspace()
    const emptyBroker: PluginBroker = {
      available: () => true,
      mutate: async () => ({}),
      read: async () => ({ type: 'response', ready: true, result: { base: 'intent', subtypes: [] } }),
    }
    const list = invokeOf(intentTools(emptyBroker, ws), 'mcp.au_host_intent_list')
    const res = await list({})
    expect(res.isError).toBeUndefined()
    const content = res.content as { intents: unknown[]; note?: string }
    expect(content.intents).toEqual([])
    expect(content.note).toMatch(/no intents/i)
  })

  it('fireErrorMessage re-splits a coded host refusal from a transport failure', () => {
    // A default-deny refusal (the host-relay client collapsed its ok:false into a rejection):
    // named as a refusal, coded, and steered to au_host_intent_list.
    const refused = fireErrorMessage('promote-intent', 'not-declared-agent-firable: promote-intent is firer-relative')
    expect(refused).toMatch(/refused by the host \(not-declared-agent-firable\)/)
    expect(refused).toMatch(/au_host_intent_list/)
    expect(fireErrorMessage('open-pane-intent', 'privileged-payload: carries an arbitrary projection config')).toMatch(/privileged-payload/)
    // A real transport failure (no known code) keeps the generic framing, not a false "refused".
    const transport = fireErrorMessage('open-intent', "host command 'fireIntent' (id 3) timed out")
    expect(transport).toMatch(/intent fire failed/)
    expect(transport).not.toMatch(/refused by the host/)
  })

  it('au_host_intent_list fails clearly with no engine', async () => {
    const ws = await tempWorkspace()
    const list = invokeOf(intentTools(noEngineBroker(), ws), 'mcp.au_host_intent_list')
    const res = await list({})
    expect(res).toMatchObject({ isError: true })
    expect(String((res as { content: unknown }).content)).toMatch(/no engine/i)
  })

  it('au_host_snapshot degrades cleanly when no host is running', async () => {
    const ws = await tempWorkspace() // no host socket
    const snap = invokeOf(intentTools(noEngineBroker(), ws), 'mcp.au_host_snapshot')
    const res = await snap({})
    expect(res).toMatchObject({ isError: true })
    expect(String((res as { content: unknown }).content)).toMatch(/no host is running/i)
  })

  it('au_host_pane_op requires an op, and activate requires a paneId', async () => {
    const ws = await tempWorkspace()
    const op = invokeOf(intentTools(noEngineBroker(), ws), 'mcp.au_host_pane_op')
    const noOp = await op({})
    expect(noOp).toMatchObject({ isError: true })
    expect(String((noOp as { content: unknown }).content)).toMatch(/'op' is required/i)
    const noPane = await op({ op: 'activate' })
    expect(noPane).toMatchObject({ isError: true })
    expect(String((noPane as { content: unknown }).content)).toMatch(/paneId/i)
    expect(String((noPane as { content: unknown }).content)).toMatch(/au_host_snapshot/)
  })

  it('au_host_pane_op degrades cleanly when no host is running', async () => {
    const ws = await tempWorkspace() // no host socket
    const op = invokeOf(intentTools(noEngineBroker(), ws), 'mcp.au_host_pane_op')
    const res = await op({ op: 'activate', paneId: 'ed1' })
    expect(res).toMatchObject({ isError: true })
    expect(String((res as { content: unknown }).content)).toMatch(/no host is running/i)
  })
})
