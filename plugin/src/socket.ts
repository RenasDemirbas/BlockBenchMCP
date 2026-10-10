// WebSocket bridge client: dials out to the MCP server (which hosts the WS
// server). Outbound browser WebSocket needs no Blockbench permissions.
import { getHandler, CommandError, listExternalTools, onExternalToolsChange } from './registry';

export const PLUGIN_VERSION = '1.8.0';

let ws: WebSocket | null = null;
let reconnectTimer: any = null;
let stopped = false;
let queue: Promise<void> = Promise.resolve();

export function connectionState(): string {
  if (!ws) return 'disconnected';
  return ['connecting', 'connected', 'closing', 'disconnected'][ws.readyState] || 'unknown';
}

function getPort(): number {
  return Settings.get('mcp_bridge_port') || 8188;
}

async function handleMessage(raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || !msg.id || !msg.command) return;
  const send = (payload: any) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };
  const handler = getHandler(msg.command);
  if (!handler) {
    send({ id: msg.id, ok: false, error: `Unknown command "${msg.command}"` });
    return;
  }
  try {
    const result = await handler(msg.params || {});
    send({ id: msg.id, ok: true, result: result ?? { done: true } });
  } catch (err: any) {
    const message = err instanceof CommandError
      ? err.message
      // No stack: its frames point into the bundle, useless to the model. The console keeps it.
      : `Blockbench error in ${msg.command}: ${err?.message || err}`;
    console.error('[MCP]', err);
    send({ id: msg.id, ok: false, error: message });
  }
}

export function connect() {
  if (stopped) return;
  clearTimeout(reconnectTimer);
  try {
    ws = new WebSocket(`ws://127.0.0.1:${getPort()}/blockbench`);
  } catch (err) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    console.log(`[MCP] Connected to MCP server on port ${getPort()}`);
    ws!.send(JSON.stringify({
      event: 'hello',
      blockbench_version: Blockbench.version,
      plugin_version: PLUGIN_VERSION,
      tools: listExternalTools(),
    }));
  };
  ws.onmessage = (event) => {
    // Serialize command handling — one command at a time, in order.
    const data = String(event.data);
    queue = queue.then(() => handleMessage(data)).catch(() => {});
  };
  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => { /* onclose fires next */ };
}

onExternalToolsChange(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'tools', tools: listExternalTools() }));
});

function scheduleReconnect() {
  if (stopped) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2500);
}

export function restart() {
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch {}
    ws = null;
  }
  stopped = false;
  connect();
}

export function shutdown() {
  stopped = true;
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch {}
    ws = null;
  }
}
