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
