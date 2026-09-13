// The redirect mediator — the native-tool allowlist enforcer, a loadable MEDIATOR
// floor (plan 2608261532, Phase 5.3). Migrated from au-mcp-redirect.
//
// It reads the session's native-tool whitelist from MediationContext.launch.nativeToolAllowlist
// (the Phase-5.3 field), instead of the daemon-injected flag-and-allowlist pair. So it is a TRUE
// plugin over the SDK contract (decision 2608261517): a user could rebuild it over the same handle.
//
// A TRUE WHITELIST, no exceptions:
//  - allowlist absent -> INERT: every native tool allowed.
//  - allowlist present (`[]` or `[names]`) -> allow a native tool iff it is listed; deny the rest
//    and point the agent at the gate equivalent. Nothing is implicitly allowed (not WebFetch, not
//    AskUserQuestion — if you want one, list it).
// The au-mcp gate tools (matched by the session gatePrefix) stay available regardless — they are
// the gate surface, not natives. Inert without a gatePrefix (there is no gate to redirect to),
// preserving the kernel's former flag-and-gatePrefix activation.

import {
  EventKind,
  type PluginContext,
  type PluginRuntime,
  type PendingAction,
  type MediationContext,
  type Decision,
} from '@arsumbris/au-mcp-sdk'

/** Build the redirect decide function. Everything per-session comes from the MediationContext. */
export function redirectDecide() {
  return (action: PendingAction, ctx: MediationContext): Decision => {
    const allowlist = ctx.launch.nativeToolAllowlist
    if (allowlist === undefined) return { kind: 'allow' } // no allowlist -> inert (all native allowed)
    const gatePrefix = ctx.launch.gatePrefix
    if (!gatePrefix) return { kind: 'allow' } // no gate to redirect to -> inert (parity with the former flag-and-gatePrefix activation)
    const tool = action.tool
    if (tool.startsWith(gatePrefix)) return { kind: 'allow' } // a gate tool: the gate surface, not a native
    if (allowlist.includes(tool)) return { kind: 'allow' } // a whitelisted native
    // Deny — point at the gate equivalent when the adapter declared one.
    const native = ctx.nativeTools.find((n) => n.name === tool)
    const reason = native?.gateEquivalent
      ? `${tool} is not in this session's native-tool allowlist; use ${native.gateEquivalent} instead`
      : `${tool} is not in this session's native-tool allowlist`
    ctx.emit(EventKind.ToolDenied, { tool, input: action.input, reason, belt: 'hook' })
    return { kind: 'deny', reason, useInstead: native?.gateEquivalent }
  }
}

/**
 * The loadable entry. Manifest (id `mcp.nativeToolRedirect`, kind hook, shapes [mediator], tier gate,
 * critical) is derived from the type-def's `plugin-runtime-meta`; this module exports only the
 * shape function. Construction needs no `ctx` — everything is read per-session from the
 * MediationContext at decide.
 */
export function createPlugin(_ctx: PluginContext): PluginRuntime {
  return { decide: redirectDecide() }
}
