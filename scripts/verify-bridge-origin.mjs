// Bridge origin check: spawns the MCP server and opens WebSockets with different
// Origin headers. Node clients (no Origin) and the Blockbench window (file://) must
// connect; websites and sandboxed pages ("null") must be refused at the handshake.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(root, 'dist', 'mcp-server.js');
const PORT = 8190; // avoid clashing with a real running instance

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, BB_BRIDGE_PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'pipe'],
});

async function waitForPort(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function tryConnect(origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/blockbench`, origin ? { origin } : {});
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
  });
}

const cases = [
  [undefined, true],
  ['file://', true],
  ['https://evil.example', false],
  ['http://localhost:3000', false],
  ['null', false],
];

let failed = 0;
try {
  if (!(await waitForPort(PORT))) throw new Error('WS bridge port never came up');
  for (const [origin, expected] of cases) {
    const got = await tryConnect(origin);
    const pass = got === expected;
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'} origin=${origin ?? '(none)'} expected=${expected ? 'open' : 'refused'} got=${got ? 'open' : 'refused'}`);
  }
} catch (err) {
  failed++;
  console.error('FAIL', err.message);
} finally {
  child.kill();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
