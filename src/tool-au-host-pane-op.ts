import type { PluginContext, PluginRuntime } from '@arsumbris/au-mcp-sdk'
import { intentToolInvoke } from './intent-tools.ts'

export function createPlugin(ctx: PluginContext): PluginRuntime {
  return { invoke: intentToolInvoke('mcp.au_host_pane_op', ctx.broker, ctx.workspace) }
}
