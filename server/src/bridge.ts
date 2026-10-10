// Bridge between MCP server instances and the Blockbench plugin.
//
// The first server instance to start becomes the HUB: it owns the WebSocket
// server on 127.0.0.1:PORT that the Blockbench plugin dials into. Any further
// instances (e.g. classic Claude Desktop chat + a Cowork/Claude Code session
// running at the same time) detect the port is taken and become CLIENTS of the
// hub, relaying their commands through it. If the hub process dies, clients
// race to take over the port.
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.BB_BRIDGE_PORT || 8188);
const DEFAULT_TIMEOUT_MS = 30_000;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

let mode: 'hub' | 'client' | 'starting' = 'starting';
const plugins: WebSocket[] = []; // hub mode: connected Blockbench windows
const clients = new Set<WebSocket>(); // hub mode: relay clients (other MCP instances)
let upstream: WebSocket | null = null; // client mode: connection to the hub
let pluginInfo: { blockbench_version?: string; plugin_version?: string } = {};
const pending = new Map<string, Pending>(); // this instance's own in-flight calls
const relayRoutes = new Map<string, WebSocket>(); // hub: relayed request id -> client socket

// Tools other Blockbench plugins registered (plugin/src/registry.ts ExternalTool).
export type ExternalTool = { name: string; title?: string; description: string; inputSchema: Record<string, any>; annotations?: Record<string, any> };
let externalTools: ExternalTool[] = [];
const pluginTools = new Map<WebSocket, unknown>(); // hub: each Blockbench window's list
let externalToolsListener: (tools: ExternalTool[]) => void = () => {};

export function onExternalTools(fn: (tools: ExternalTool[]) => void) {
  externalToolsListener = fn;
  fn(externalTools);
}

function setExternalTools(tools: unknown) {
  externalTools = Array.isArray(tools) ? tools : [];
  externalToolsListener(externalTools);
  const msg = JSON.stringify({ event: 'tools', tools: externalTools });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function activePlugin(): WebSocket | null {
  for (let i = plugins.length - 1; i >= 0; i--) {
    if (plugins[i].readyState === WebSocket.OPEN) return plugins[i];
  }
  return null;
}

const NOT_CONNECTED_MSG =
  'Blockbench is not connected. Make sure: 1) Blockbench is running, 2) the "Blockbench MCP Bridge" plugin is installed (File > Plugins > Load Plugin from File) and enabled. The plugin auto-connects within ~3 seconds of Blockbench starting.';

function rejectAllPending(message: string) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new BridgeError(message));
    pending.delete(id);
  }
}

// ─────────────────────────────── hub mode ───────────────────────────────

// Browsers always send Origin and a page cannot fake it. Relay instances and test
// scripts (Node) send none; the Blockbench window is a file:// page. Any other origin is
// a website trying to drive Blockbench (eval_code = code execution on this machine).
function isAllowedOrigin(origin: string | undefined): boolean {
  return !origin || origin === 'file://';
}

function startHub(): Promise<boolean> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: PORT,
      maxPayload: 64 * 1024 * 1024,
      verifyClient: ({ origin }) => {
        if (isAllowedOrigin(origin)) return true;
        console.error(`[bridge] hub: refused connection from origin ${origin}`);
        return false;
      },
    });
    wss.on('listening', () => {
      mode = 'hub';
      console.error(`[bridge] hub: WebSocket server listening on ws://127.0.0.1:${PORT}`);
      resolve(true);
    });
    wss.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false); // another instance owns the port — become a client
      } else {
        console.error('[bridge] hub error:', err.message);
        resolve(false);
      }
    });
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.event === 'hello') {
          // A Blockbench window announced itself
          if (!plugins.includes(socket)) plugins.push(socket);
          pluginInfo = { blockbench_version: msg.blockbench_version, plugin_version: msg.plugin_version };
          console.error(`[bridge] hub: Blockbench ${msg.blockbench_version} connected (plugin ${msg.plugin_version})`);
          pluginTools.set(socket, msg.tools);
          setExternalTools(pluginTools.get(activePlugin()!));
          return;
        }
        if (msg.event === 'tools' && plugins.includes(socket)) {
          pluginTools.set(socket, msg.tools);
          setExternalTools(pluginTools.get(activePlugin()!));
          return;
        }
        if (msg.event === 'client-hello') {
          clients.add(socket);
          socket.send(JSON.stringify({ event: 'tools', tools: externalTools }));
          console.error('[bridge] hub: relay client connected (another MCP instance)');
          return;
        }
        if (msg.id && msg.command) {
          // Relay request from a client instance → forward to Blockbench
          const target = activePlugin();
          if (!target) {
            socket.send(JSON.stringify({ id: msg.id, ok: false, error: NOT_CONNECTED_MSG }));
            return;
          }
          relayRoutes.set(msg.id, socket);
          target.send(JSON.stringify(msg));
          return;
        }
        if (msg.id) {
          // Response from the plugin — route to whoever asked
          const client = relayRoutes.get(msg.id);
          if (client) {
            relayRoutes.delete(msg.id);
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
            return;
          }
          const entry = pending.get(msg.id);
          if (entry) {
            pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.ok) entry.resolve(msg.result);
            else entry.reject(new Error(msg.error || 'Unknown Blockbench error'));
          }
        }
      });
      socket.on('close', () => {
        const idx = plugins.indexOf(socket);
        if (idx >= 0) {
          plugins.splice(idx, 1);
          pluginTools.delete(socket);
          setExternalTools(pluginTools.get(activePlugin()!));
          console.error('[bridge] hub: Blockbench window disconnected');
          if (!activePlugin()) {
            rejectAllPending('Blockbench disconnected while the command was running.');
            for (const [id, client] of relayRoutes) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ id, ok: false, error: 'Blockbench disconnected while the command was running.' }));
              }
              relayRoutes.delete(id);
            }
          }
        }
        if (clients.delete(socket)) {
          for (const [id, client] of relayRoutes) {
            if (client === socket) relayRoutes.delete(id);
          }
        }
      });
      socket.on('error', () => { /* close fires next */ });
    });
  });
}

// ────────────────────────────── client mode ──────────────────────────────

function startClient(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/blockbench`);
    let settled = false;
    socket.on('open', () => {
      mode = 'client';
      upstream = socket;
      socket.send(JSON.stringify({ event: 'client-hello' }));
      console.error('[bridge] client: relaying through existing hub instance');
      settled = true;
      resolve(true);
    });
    socket.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.event === 'tools') {
        setExternalTools(msg.tools);
        return;
      }
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error || 'Unknown Blockbench error'));
      }
    });
    socket.on('close', () => {
      if (upstream === socket) upstream = null;
      rejectAllPending('Bridge connection lost — retrying.');
      if (settled) {
        // Hub died — try to take over the port, else reconnect
        setTimeout(ensureBridge, 800);
      } else {
        settled = true;
        resolve(false);
      }
    });
    socket.on('error', () => { /* close fires next */ });
  });
}

// ─────────────────────────────── lifecycle ───────────────────────────────

async function ensureBridge(): Promise<void> {
  if (mode === 'hub') return;
  if (await startHub()) return;
  if (await startClient()) return;
  setTimeout(ensureBridge, 1500);
}

export async function startBridge(): Promise<void> {
  await ensureBridge();
}

export function isConnected(): boolean {
  if (mode === 'hub') return !!activePlugin();
  return !!upstream && upstream.readyState === WebSocket.OPEN;
}

export function getPluginInfo() {
  return pluginInfo;
}

export class BridgeError extends Error {}

export function call(command: string, params: any = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  const target = mode === 'hub' ? activePlugin() : (upstream && upstream.readyState === WebSocket.OPEN ? upstream : null);
  if (!target) {
    return Promise.reject(new BridgeError(NOT_CONNECTED_MSG));
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new BridgeError(`Blockbench did not respond within ${Math.round(timeoutMs / 1000)}s. The app may be busy or showing a dialog.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    target.send(JSON.stringify({ id, command, params }));
  });
}
