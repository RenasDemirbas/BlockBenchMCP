// Tools other Blockbench plugins registered, mirrored into this MCP server.
import { z as z4 } from 'zod/v4';
import { type McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forward } from '../respond';
import { type ExternalTool } from '../bridge';

const externalTools = new Map<string, { tool: RegisteredTool; json: string }>();

/** Mirror the tools other Blockbench plugins registered (window.BlockbenchMCP.registerTool). */
export function syncExternalTools(server: McpServer, tools: ExternalTool[]) {
  const next = new Map(tools.map((t) => [t.name, JSON.stringify(t)]));
  for (const [name, entry] of externalTools) {
    if (next.get(name) !== entry.json) {
      entry.tool.remove();
      externalTools.delete(name);
    }
  }
  for (const t of tools) {
    if (externalTools.has(t.name)) continue;
    // The SDK only takes Zod. The plugin's JSON Schema rides along as metadata, which the SDK's
    // JSON Schema export copies into tools/list; the plugin checks the arguments itself.
    // "id" is dropped because Zod treats it as a registry key and throws on duplicates.
    const { id: _id, ...jsonSchema } = t.inputSchema;
    try {
      const tool = server.registerTool(t.name, {
        title: t.title,
        description: t.description,
        inputSchema: z4.object({}).loose().meta(jsonSchema),
        annotations: t.annotations,
      }, forward(t.name, 120_000));
      externalTools.set(t.name, { tool, json: next.get(t.name)! });
    } catch (err) {
      console.error(`[mcp] skipped plugin tool "${t.name}": ${(err as Error).message}`);
    }
  }
}
