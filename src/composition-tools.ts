// First-party COMPOSITION mutation callables: author an editable member's
// `.arsumbris/repo.yaml` (`deps:`) or `.arsumbris/workspace.yaml` (`edit:` /
// `discover:`) through the engine's mutation channel.
//
// The governed write path for a repo's dependencies + a workspace's membership.
// It is the sanctioned dual of hand-editing `.arsumbris/`, which the engine
// refuses outright (`writes under .arsumbris/ are rejected — the cache is the
// engine's`). Five verbs, one per composition change: add_dep / remove_dep /
// add_workspace_member / remove_workspace_member / set_workspace_member_role.
// Each re-resolves the mounted set + rebuilds (deps fold into the closure hash,
// so it is an identity change). Like every mutation, they REFUSE with no engine
// (paired 1:1, no unguarded fs fallback).
//
// These take a member `name` (+ optional `role` / `root` / `remote` / `ref`),
// NOT a file path — the engine derives the `.arsumbris/` file from `root` (absent
// = the served entry). So there is no path guard; the engine's editability gate
// is the whole check. The reject surface (a duplicate, an absent target, a
// non-editable `root`) is surfaced verbatim by `mutationResult`.
//
// See au-engine message 260914224057 (the originating ask) and the au-engine-sdk
// DaemonClient composition methods the broker forwards to.

import type { Plugin, CallableResult, PluginBroker } from '@arsumbris/au-mcp-sdk'
import { fail, optString } from './result.ts'
import { callable, mutationResult } from './file-tools.ts'

/**
 * The five composition primitives, scoped to `workspace`. Mutations route through
 * `broker`'s engine mutation channel; when no broker/engine is present they refuse.
 */
export function compositionTools(workspace: string, broker?: PluginBroker): Plugin[] {
  const noEngine = (verb: string): CallableResult =>
    fail(`cannot ${verb}: no engine for this workspace — the gate routes reads + writes through the engine, which is not reachable`)

  // The optional shared args every composition verb accepts: `root` (the editable
  // member to author, absent = the served entry) + `expected_hash` (a compare-and-set,
  // undeclared like the file tools — a caller or mediator may inject it). The engine
  // keys the target by member `name`, so no path is passed and no path guard applies.
  const shared = (input: unknown, args: Record<string, unknown>): void => {
    const root = optString(input, 'root')
    if (root !== undefined) args.root = root
    const expected_hash = optString(input, 'expected_hash')
    if (expected_hash !== undefined) args.expected_hash = expected_hash
  }

  const roleOf = (input: unknown): 'edit' | 'discover' | undefined => {
    const role = optString(input, 'role')
    return role === 'edit' || role === 'discover' ? role : undefined
  }

  // Add a `deps:` entry to a repo's `.arsumbris/repo.yaml`. Does NOT fetch — the new
  // peer stays `peer-unmounted` until `resolve`. `remote` / `ref` pin the source;
  // omit both for a registry-resolved local peer.
  const addDepTool = callable('mcp.add_dep', 'Add Repo Dependency', async (input) => {
    const name = optString(input, 'name')
    if (!name) return fail("'name' is required (the dependency repo name to add)")
    if (!broker || !broker.available()) return noEngine('add a dependency')
    const args: Record<string, unknown> = { name }
    const remote = optString(input, 'remote')
    if (remote !== undefined) args.remote = remote
    const ref = optString(input, 'ref')
    if (ref !== undefined) args.ref = ref
    shared(input, args)
    try {
      return mutationResult(workspace, await broker.mutate('add_dep', args), undefined, `added dependency ${name}`)
    } catch (e) {
      return fail(`cannot add dependency ${name}: ${(e as Error).message}`)
    }
  })

  // Remove a `deps:` entry (matched by name) from a repo's `.arsumbris/repo.yaml`.
  const removeDepTool = callable('mcp.remove_dep', 'Remove Repo Dependency', async (input) => {
    const name = optString(input, 'name')
    if (!name) return fail("'name' is required (the dependency repo name to remove)")
    if (!broker || !broker.available()) return noEngine('remove a dependency')
    const args: Record<string, unknown> = { name }
    shared(input, args)
    try {
      return mutationResult(workspace, await broker.mutate('remove_dep', args), undefined, `removed dependency ${name}`)
    } catch (e) {
      return fail(`cannot remove dependency ${name}: ${(e as Error).message}`)
    }
  })

  // Add a member to a workspace's `edit:` or `discover:` list, authoring
  // `.arsumbris/workspace.yaml` (CREATED self-complete when absent). Rejects a member
  // already in either list — use set_workspace_member_role to change its role.
  const addMemberTool = callable('mcp.add_workspace_member', 'Add Workspace Member', async (input) => {
    const name = optString(input, 'name')
    if (!name) return fail("'name' is required (the member repo name to add)")
    const role = roleOf(input)
    if (role === undefined) return fail("'role' is required and must be \"edit\" or \"discover\"")
    if (!broker || !broker.available()) return noEngine('add a workspace member')
    const args: Record<string, unknown> = { name, role }
    shared(input, args)
    try {
      return mutationResult(workspace, await broker.mutate('add_workspace_member', args), undefined, `added ${role} member ${name}`)
    } catch (e) {
      return fail(`cannot add workspace member ${name}: ${(e as Error).message}`)
    }
  })

  // Remove a member from whichever of `edit:` / `discover:` holds it.
  const removeMemberTool = callable('mcp.remove_workspace_member', 'Remove Workspace Member', async (input) => {
    const name = optString(input, 'name')
    if (!name) return fail("'name' is required (the member repo name to remove)")
    if (!broker || !broker.available()) return noEngine('remove a workspace member')
    const args: Record<string, unknown> = { name }
    shared(input, args)
    try {
      return mutationResult(workspace, await broker.mutate('remove_workspace_member', args), undefined, `removed member ${name}`)
    } catch (e) {
      return fail(`cannot remove workspace member ${name}: ${(e as Error).message}`)
    }
  })

  // Move a member between `edit:` and `discover:` in one commit; `role` is the TARGET
  // list. Rejects a member already in the target role, or an absent member.
  const setRoleTool = callable('mcp.set_workspace_member_role', 'Set Workspace Member Role', async (input) => {
    const name = optString(input, 'name')
    if (!name) return fail("'name' is required (the member repo name)")
    const role = roleOf(input)
    if (role === undefined) return fail("'role' is required and must be \"edit\" or \"discover\" (the target list)")
    if (!broker || !broker.available()) return noEngine('set a workspace member role')
    const args: Record<string, unknown> = { name, role }
    shared(input, args)
    try {
      return mutationResult(workspace, await broker.mutate('set_workspace_member_role', args), undefined, `set member ${name} to ${role}`)
    } catch (e) {
      return fail(`cannot set workspace member role for ${name}: ${(e as Error).message}`)
    }
  })

  const tools = [addDepTool, removeDepTool, addMemberTool, removeMemberTool, setRoleTool]
  // DECLARE each tool's engine access (least privilege) by OBJECT — the composition
  // verbs mutate, so `read-write`, the name-free source a guard reads at decide.
  for (const t of tools) {
    if (t.manifest.kind === 'tool') t.manifest.access = 'read-write'
  }
  return tools
}

// Loadable-plugin adapter (mirrors fileToolInvoke): extract ONE composition tool's
// invoke by id, for a thin per-tool `createPlugin` entry. The daemon derives the
// manifest from the def and injects the invoke seam, so a loadable composition write
// is governed identically.
export function compositionToolInvoke(
  id: string,
  workspace: string,
  broker: PluginBroker | undefined,
): (input: unknown) => Promise<CallableResult> {
  const tool = compositionTools(workspace, broker).find((p) => p.manifest.id === id)
  if (!tool?.invoke) return async () => fail(`unknown composition tool: ${id}`)
  return tool.invoke as (input: unknown) => Promise<CallableResult>
}
