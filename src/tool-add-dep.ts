import type { PluginContext, PluginRuntime } from '@arsumbris/au-mcp-sdk'
import { compositionToolInvoke } from './composition-tools.ts'

export function createPlugin(ctx: PluginContext): PluginRuntime {
  return { invoke: compositionToolInvoke('mcp.add_dep', ctx.workspace, ctx.broker) }
}
