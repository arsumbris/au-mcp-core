// The instance-count-notice session-start hook (decision 2609020302).
//
// The canonical first-party SESSION-START hook: at session-open, count instances of the configured
// type and inject a notice when the count exceeds the threshold. Recomputed per session against
// LIVE graph state (unlike a static mcp.inject). INERT until configured — no config, no inject.
//
// Config is TYPED, not an untyped JSON blob (decision 2609021429, fields-are-config). The def's
// fields ARE the config; the daemon reads the active agent-profile's `hookConfig` from the graph,
// runs this hook ONCE PER configured instance, and passes that instance's typed fields as `config`.
// The config type (`McpHookInstanceCountNotice`) is GENERATED from the def by au-type-codegen
// (`npm run gen:types`) — the def is the single source of truth, no hand-written interface or
// validator. `forType` is a `type*` def-ref: the engine validates it names a real type, and it rides
// the wire as a wikilink this hook reduces to the bare name for `instances_of`.

import type { PluginContext, PluginRuntime, SessionStartContext, SessionStartResult } from '@arsumbris/au-mcp-sdk'
import type { McpHookInstanceCountNotice } from './generated.ts'

/** This hook's config: one instance's typed fields, as generated from the def. */
type Config = McpHookInstanceCountNotice

/** Narrow the daemon-delivered config (typed `unknown` at the SDK boundary) to this hook's fields.
 *  The engine has already VALIDATED the instance; this only READS it (no re-validation). Undefined
 *  when the required fields are absent (a config-less run injects nothing). */
function readConfig(config: unknown): Config | undefined {
  const c = config as Partial<Config> | undefined
  if (typeof c?.forType !== 'string' || typeof c?.threshold !== 'number') return undefined
  return c as Config
}

/** A `type*` def-ref value is a wikilink (`[[task::repo]]`, plus optional `#head` / `^id` fragments);
 *  reduce it to the bare type name `instances_of` wants. A bare value passes through unchanged. */
function typeName(forType: string): string {
  return forType.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('::')[0].split('#')[0].split('^')[0].trim()
}

/** Render the notice, expanding the optional placeholders. */
function render(cfg: Config, type: string, count: number): string {
  const base = cfg.message ?? `⚠ ${count} instances of type '${type}' (over threshold ${cfg.threshold}).`
  return base
    .replaceAll('{count}', String(count))
    .replaceAll('{n}', String(count))
    .replaceAll('{type}', type)
    .replaceAll('{threshold}', String(cfg.threshold))
}

export function createPlugin(_ctx: PluginContext): PluginRuntime {
  return {
    async onSessionStart(ctx: SessionStartContext, config?: unknown): Promise<SessionStartResult> {
      const cfg = readConfig(config)
      if (!cfg) return // unconfigured -> inject nothing
      const broker = ctx.broker
      if (!broker || !broker.available()) return // no engine for this workspace
      const type = typeName(cfg.forType)
      let frame
      try {
        frame = await broker.read('instances_of', { type })
      } catch {
        return // an engine hiccup -> no inject, never the session
      }
      if (frame.ready === false || frame.type === 'error') return // not ready / unknown type
      const count = Array.isArray(frame.result) ? frame.result.length : 0
      return count > cfg.threshold ? { inject: [render(cfg, type, count)] } : undefined
    },
  }
}
