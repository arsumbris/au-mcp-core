import type { PluginContext, PluginRuntime } from '@arsumbris/au-mcp-sdk'
import { fileToolInvoke } from './file-tools.ts'

export function createPlugin(ctx: PluginContext): PluginRuntime {
  return { invoke: fileToolInvoke('mcp.rename_block_id', ctx.workspace, ctx.broker) }
}
