// The repo-overview session-start hook (decision 2609020302).
//
// At session-open, inject a REPOSITORY OVERVIEW of the mounted members, tiered by ROLE so the
// budget goes where the attention should:
//   - EDITABLE (entry + edit, the surfaces you author) -> a FULL block each: repo link, README
//     `tldr`, README link.
//   - DISCOVER (pinned for type discovery)             -> a COMPACT line, just the repo names.
//   - DEP (consumed type-dependencies)                 -> just a COUNT, plus how to list them.
// Recomputed per session against LIVE graph state (the mounted set + each README's tldr), unlike a
// static mcp.inject.
//
// CONFIG-LESS + always-on: no `hookConfig`, so the daemon calls it once with `config` undefined. It
// reads two engine reads through the read-only broker:
//   - `members`                         -> the mounted members + their role (the spine).
//   - `instances_of(au.engine.readme)`  -> each README's owning `member` + frontmatter `fields.tldr`.
// It joins them by member name: an editable repo's one-liner is its README's `tldr`, falling back to
// the repo name when a README or its tldr is absent. Best-effort — an engine hiccup / down engine
// injects nothing, never the session.

import type {
  EngineFrame,
  PluginContext,
  PluginRuntime,
  SessionStartContext,
  SessionStartResult,
} from '@arsumbris/au-mcp-sdk'

/** The engine-owned repo-README type; its `file` instances carry the per-repo `tldr` we index. */
const README_TYPE = 'au.engine.readme'

/** The `members` (WireMember) row fields we need: the member's name, its role, mounted state. */
interface MemberRow {
  repo: string
  role?: 'entry' | 'edit' | 'discover' | 'dep'
  editable?: boolean
  disabled?: boolean
}

/** The `instances_of` match (WireInstanceMatch) fields we need: the owning member + its frontmatter. */
interface ReadmeRow {
  member: string
  fields?: Record<string, unknown>
}

/** A non-empty string `tldr` off a README's frontmatter, else undefined (drives the name fallback). */
function tldrOf(fields: Record<string, unknown> | undefined): string | undefined {
  const t = fields?.['tldr']
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : undefined
}

/** An engine frame's array result, or [] on a not-ready / error / non-array frame. */
function rowsOf<T>(frame: EngineFrame | undefined): T[] {
  if (!frame || frame.ready === false || frame.type === 'error') return []
  return Array.isArray(frame.result) ? (frame.result as T[]) : []
}

/** How to drill into any repo, appended so discover / dep tiers stay compact but explorable. */
const EXPLORE_HINT =
  'To get details: au_members lists every member with its role; ' +
  'au_follow [[README::<repo>]] or read_file_pinned reads one repo\'s README; ' +
  'au_instances_of { ofType: "au.engine.readme::au-engine" } lists all README tldrs.'

/** Name-sort a member group. */
function byRepo(a: MemberRow, b: MemberRow): number {
  return a.repo.localeCompare(b.repo)
}

/** One full block for an editable repo: link, README tldr (name fallback), README link. */
function fullBlock(m: MemberRow, byMember: Map<string, ReadmeRow>): string {
  const readme = byMember.get(m.repo)
  const tldr = tldrOf(readme?.fields) ?? m.repo
  const readmeLink = readme ? `[[README::${m.repo}]]` : '(no README)'
  return `[[::${m.repo}]]\ntldr: ${tldr}\nreadme: ${readmeLink}`
}

/** Render the tiered overview block, or undefined when there is no member to show. */
function render(members: MemberRow[], readmes: ReadmeRow[]): string | undefined {
  // First README per member wins (a repo has one canonical root README).
  const byMember = new Map<string, ReadmeRow>()
  for (const r of readmes) if (r.member && !byMember.has(r.member)) byMember.set(r.member, r)

  const active = members.filter((m) => m.repo && m.disabled !== true)
  // Role partition. `editable` (the derived entry+edit signal) is authoritative; fall back to role.
  const editable = active.filter((m) => m.editable === true || m.role === 'entry' || m.role === 'edit').sort(byRepo)
  const discover = active.filter((m) => m.role === 'discover' && m.editable !== true).sort(byRepo)
  const deps = active.filter((m) => m.role === 'dep' && m.editable !== true).sort(byRepo)
  if (active.length === 0) return undefined

  const sections: string[] = []
  if (editable.length > 0) {
    // Full blocks only for editables that HAVE a README; the rest compact to one nudge line
    // (a full block with just a name earns nothing, and the engine's repo-missing-readme
    // diagnostic already tracks the gap).
    const withReadme = editable.filter((m) => byMember.has(m.repo))
    const noReadme = editable.filter((m) => !byMember.has(m.repo))
    const parts: string[] = ['EDITABLE REPOSITORIES (the surfaces you author):']
    if (withReadme.length > 0) parts.push(withReadme.map((m) => fullBlock(m, byMember)).join('\n\n'))
    if (noReadme.length > 0) parts.push('Editable, no README yet: ' + noReadme.map((m) => m.repo).join(', '))
    sections.push(parts.join('\n\n'))
  }
  if (discover.length > 0) {
    sections.push(
      'DISCOVERY-MOUNTED REPOSITORIES (pinned for type discovery):\n' + discover.map((m) => m.repo).join(', '),
    )
  }
  if (deps.length > 0) {
    sections.push(`${deps.length} ${deps.length === 1 ? 'DEPENDENCY' : 'DEPENDENCIES'} mounted (consumed type-dependencies).`)
  }
  sections.push(EXPLORE_HINT)

  return 'Generated Repository Overview:\n\n' + sections.join('\n\n')
}

export function createPlugin(_ctx: PluginContext): PluginRuntime {
  return {
    async onSessionStart(ctx: SessionStartContext): Promise<SessionStartResult> {
      const broker = ctx.broker
      if (!broker || !broker.available()) return // no engine for this workspace -> nothing to inject
      let memberFrame: EngineFrame
      let readmeFrame: EngineFrame
      try {
        memberFrame = await broker.read('members')
        readmeFrame = await broker.read('instances_of', { type: README_TYPE, origins: ['file'] })
      } catch {
        return // an engine hiccup -> no inject, never the session
      }
      const members = rowsOf<MemberRow>(memberFrame)
      if (members.length === 0) return // members unreadable -> skip, never inject a partial overview
      const block = render(members, rowsOf<ReadmeRow>(readmeFrame))
      return block ? { inject: [block] } : undefined
    },
  }
}
