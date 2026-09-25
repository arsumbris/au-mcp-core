import type { PluginContext, PluginRuntime } from '@arsumbris/au-mcp-sdk'
import { compositionToolInvoke } from './composition-tools.ts'

export function createPlugin(ctx: PluginContext): PluginRuntime {
  return { invoke: compositionToolInvoke('mcp.remove_workspace_member', ctx.workspace, ctx.broker) }
}
