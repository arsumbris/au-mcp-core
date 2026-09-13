import type { PluginContext, PluginRuntime } from '@arsumbris/au-mcp-sdk'
import { fileToolInvoke } from './file-tools.ts'

export function createPlugin(ctx: PluginContext): PluginRuntime {
  return { invoke: fileToolInvoke('mcp.delete_file', ctx.workspace, ctx.broker) }
}
