// The requiredScope-check session-start hook (decision 2609071712).
//
// At session-open, walk every mounted mcp.tool / mcp.hook def that declares `required-scope-meta`, and
// for each required ref consult the kernel-resolved `ctx.scope`. Inject one line per ref that is NOT
// MOUNTED (absent from every scope set) or MOUNTED BUT NOT ACTIVE (in a `mounted` set but excluded by the
// profile's allowlist). Turns silent-late-failure into a legible notice at open.
//
// CONFIG-LESS + always-on. Best-effort: no broker / a down engine -> inject nothing, never the session.
// v1 covers TOOLS + HOOKS (subtypes carry the type-level meta); skills are instances of `mcp.skill`, so a
// per-skill meta does not apply (a skill `requires` field is a follow-up).

import type {
  EngineFrame,
  PluginContext,
  PluginRuntime,
  SessionScope,
  SessionStartContext,
  SessionStartResult,
} from '@arsumbris/au-mcp-sdk'

const REQUIRES_META = 'required-scope-meta'
/** The two agent-facing bases whose SUBTYPES carry a type-level meta. Skills are instances, excluded. */
const BASES = ['mcp.tool', 'mcp.hook']

/** A meta block + a def as the `subtypes` read returns them (same small shape intent-tools uses). */
interface MetaBlock {
  type_name: string
  body: { name: string; value: unknown }[]
}
interface Def {
  name?: string
  meta_blocks?: MetaBlock[]
}

/** Match a meta block by BASE name, tolerant of a `::repo` import qualifier. */
const metaIs = (b: MetaBlock, base: string): boolean => b.type_name.split('::', 1)[0] === base
/** Flatten a meta block's `[{name,value}]` body into a record. */
const metaRecord = (b: MetaBlock): Record<string, unknown> => Object.fromEntries(b.body.map((f) => [f.name, f.value]))

/** Reduce a `type*` def-ref to the session-local TOOL HANDLE (short name) that `ctx.scope` uses.
 *  Strip `[[ ]]`, any `::repo` / `#head` / `^id`, then the `mcp.tool.` / `mcp.hook.` type prefix. So the
 *  full type name a `requires` ref resolves to (`mcp.tool.read_file_pinned`) matches `scope.tools` (`read_file_pinned`),
 *  which is short-name-keyed like the tool-visibility allowlist. A non-tool/hook type ref is unchanged. */
function shortName(ref: string): string {
  const t = ref.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('::')[0].split('#')[0].split('^')[0].trim()
  if (t.startsWith('mcp.tool.')) return t.slice('mcp.tool.'.length)
  if (t.startsWith('mcp.hook.')) return t.slice('mcp.hook.'.length)
  return t
}

/** The `requires` list off a def's `required-scope-meta`, reduced to session-local handles; [] when absent. */
function requiresOf(def: Def): string[] {
  const block = def.meta_blocks?.find((b) => metaIs(b, REQUIRES_META))
  const v = block ? metaRecord(block).requires : undefined
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(shortName) : []
}

/** The declaring def's bare name for the message: `mcp.tool.au_foo` -> `au_foo`. */
function declarerName(def: Def): string {
  return def.name ? def.name.split('.').slice(2).join('.') || def.name : '(unknown)'
}

type Status = 'ok' | 'inactive' | 'missing'
/** A required ref's availability in the resolved scope. */
function statusOf(name: string, scope: SessionScope): Status {
  if (scope.tools.active.includes(name) || scope.skills.active.includes(name) || scope.members.includes(name)) return 'ok'
  if (scope.tools.mounted.includes(name) || scope.skills.mounted.includes(name)) return 'inactive'
  return 'missing'
}

/** The `subtypes` read for one base, or [] on a not-ready / error / down frame. */
async function subtypeDefs(broker: NonNullable<SessionStartContext['broker']>, base: string): Promise<Def[]> {
  let frame: EngineFrame
  try {
    frame = await broker.read('subtypes', { base })
  } catch {
    return []
  }
  if (frame.ready === false || frame.type === 'error') return []
  const result = frame.result as { subtypes?: Def[] } | undefined
  return Array.isArray(result?.subtypes) ? result.subtypes : []
}

export function createPlugin(_ctx: PluginContext): PluginRuntime {
  return {
    async onSessionStart(ctx: SessionStartContext): Promise<SessionStartResult> {
      const broker = ctx.broker
      if (!broker || !broker.available()) return // no engine -> nothing to check
      const scope = ctx.scope

      let defs: Def[]
      try {
        defs = (await Promise.all(BASES.map((b) => subtypeDefs(broker, b)))).flat()
      } catch {
        return // an engine hiccup -> no inject, never the session
      }

      const lines: string[] = []
      for (const def of defs) {
        const reqs = requiresOf(def)
        if (reqs.length === 0) continue
        const who = declarerName(def)
        for (const req of reqs) {
          const s = statusOf(req, scope)
          if (s === 'missing') lines.push(`- ${who} expects ${req} in scope — NOT MOUNTED in this workspace.`)
          else if (s === 'inactive')
            lines.push(`- ${who} expects ${req} in scope — mounted but NOT ACTIVE this session (excluded by the profile's allowlist).`)
        }
      }
      if (lines.length === 0) return

      return { inject: [['⚠ Scope gaps (requiredScope):', '', ...lines].join('\n')] }
    },
  }
}
