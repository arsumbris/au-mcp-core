import type { PluginContext, PluginRuntime } from '@arsumbris/au-mcp-sdk'
import { engineReadInvoke } from './engine-reads.ts'

export function createPlugin(ctx: PluginContext): PluginRuntime {
  return { invoke: engineReadInvoke('mcp.au_subtypes', ctx.broker, ctx.workspace) }
}
