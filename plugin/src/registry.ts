// Command registry: the WS bridge dispatches incoming commands to these handlers.

export type CommandHandler = (params: any) => any | Promise<any>;

const handlers = new Map<string, CommandHandler>();

export function register(name: string, handler: CommandHandler) {
  handlers.set(name, handler);
}

export function getHandler(name: string): CommandHandler | undefined {
  return handlers.get(name);
}

export function listCommands(): string[] {
  return [...handlers.keys()];
}

// Tools other Blockbench plugins add through window.BlockbenchMCP.registerTool.
// The MCP server registers one MCP tool per entry and forwards calls to `handler`.
export type ExternalTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, any>; // JSON Schema of the arguments object
  annotations?: Record<string, any>;
};

const externalTools = new Map<string, ExternalTool>();
let externalToolsListener = () => {};

export function onExternalToolsChange(fn: () => void) {
  externalToolsListener = fn;
}

export function listExternalTools(): ExternalTool[] {
  return [...externalTools.values()];
}

// Errors here go to the calling plugin's developer, not the model, so plain Error.
export function registerExternalTool(def: Partial<ExternalTool>, handler: CommandHandler): { delete(): void } {
  const name = def?.name;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    throw new Error('BlockbenchMCP.registerTool: "name" must be 1-64 characters of A-Z, a-z, 0-9, "_", "-" or ".".');
  }
  if (typeof def.description !== 'string' || !def.description) {
    throw new Error(`BlockbenchMCP.registerTool("${name}"): "description" is required — it is all the model reads to decide when to call the tool.`);
  }
  if (typeof handler !== 'function') {
    throw new Error(`BlockbenchMCP.registerTool("${name}"): the second argument must be the handler function.`);
  }
  const inputSchema = def.inputSchema ?? { type: 'object', properties: {} };
  if (inputSchema.type !== 'object') {
    throw new Error(`BlockbenchMCP.registerTool("${name}"): "inputSchema" must be a JSON Schema with type "object".`);
  }
  if (handlers.has(name)) {
    throw new Error(`BlockbenchMCP.registerTool: "${name}" is already taken by a built-in or another plugin's tool.`);
  }
  const tool: ExternalTool = { name, title: def.title, description: def.description, inputSchema, annotations: def.annotations };
  handlers.set(name, handler);
  externalTools.set(name, tool);
  externalToolsListener();
  return {
    delete() {
      if (externalTools.get(name) !== tool) return;
      externalTools.delete(name);
      handlers.delete(name);
      externalToolsListener();
    },
  };
}

/** Error whose message is meant for the model — includes recovery guidance. */
export class CommandError extends Error {}

export function fail(message: string): never {
  throw new CommandError(message);
}

export function requireProject(): void {
  if (!Project) {
    fail('No project is open in Blockbench. Use create_project first (or project_file action "open" to load an existing file).');
  }
}
