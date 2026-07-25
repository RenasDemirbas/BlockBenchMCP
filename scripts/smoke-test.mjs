// Smoke test: spawns the MCP server, connects a fake Blockbench plugin over WS,
// then speaks MCP over stdio (initialize → tools/list → tools/call get_status)
// and verifies the round-trip through the bridge.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(root, 'dist', 'mcp-server.js');
const PORT = 8189; // avoid clashing with a real running instance

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, BB_BRIDGE_PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stdout.write(`[server-log] ${d}`));
child.on('error', (err) => console.error('[spawn-error]', err));
child.on('exit', (code, signal) => console.log(`[server-exit] code=${code} signal=${signal}`));

// Wait until the WS port is actually listening (max ~8s)
async function waitForPort(port, tries = 40) {
  const net = await import('node:net');
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

let buffer = '';
const responses = [];
const waiters = [];
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined) {
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else responses.push(msg);
    }
  }
});

function rpc(method, params, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
    waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed = true;
};

try {
  const up = await waitForPort(PORT);
  if (!up) throw new Error('WS bridge port never came up');

  // Fake Blockbench plugin
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/blockbench`);
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.command === 'get_status') {
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: { connected: true, blockbench_version: 'fake-5.1.4', project_open: false, open_tabs: [] } }));
    } else if (msg.command === 'capture_screenshot') {
      // 1x1 transparent png
      const px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: { angle: 'isometric_right', __image: `data:image/png;base64,${px}` } }));
    } else {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: `fake plugin has no handler for ${msg.command}` }));
    }
  });
  await new Promise((resolve, reject) => {
    ws.on('open', () => { ws.send(JSON.stringify({ event: 'hello', blockbench_version: 'fake-5.1.4', plugin_version: 'test' })); resolve(); });
    ws.on('error', reject);
  });

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.0.0' },
  }, 1);
  check('initialize', init.result?.serverInfo?.name === 'blockbench', JSON.stringify(init.result?.serverInfo));
  notify('notifications/initialized', {});

  const tools = await rpc('tools/list', {}, 2);
  const names = (tools.result?.tools || []).map((t) => t.name);
  check(`tools/list returns tools (${names.length})`, names.length >= 60);
  for (const expected of ['create_project', 'add_cubes', 'add_groups', 'set_keyframes', 'paint_texture', 'capture_screenshot', 'export_model', 'eval_code',
    'validate_model', 'query_geometry', 'mirror_elements', 'mirror_keyframes', 'paint_faces', 'add_planes', 'add_locators']) {
    check(`tool registered: ${expected}`, names.includes(expected));
  }

  const status = await rpc('tools/call', { name: 'get_status', arguments: {} }, 3);
  const statusText = status.result?.content?.[0]?.text || '';
  check('get_status round-trip through bridge', statusText.includes('fake-5.1.4'), statusText.slice(0, 120));

  const shot = await rpc('tools/call', { name: 'capture_screenshot', arguments: {} }, 4);
  const hasImage = (shot.result?.content || []).some((c) => c.type === 'image' && c.mimeType === 'image/png');
  check('capture_screenshot returns MCP image content', hasImage);

  // Second server instance on the same port → must become a relay client of the hub
  const child2 = spawn(process.execPath, [serverPath], {
    env: { ...process.env, BB_BRIDGE_PORT: String(PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child2.stderr.on('data', (d) => process.stdout.write(`[server2-log] ${d}`));
  let buffer2 = '';
  const waiters2 = [];
  child2.stdout.on('data', (chunk) => {
    buffer2 += chunk.toString();
    let idx2;
    while ((idx2 = buffer2.indexOf('\n')) >= 0) {
      const line = buffer2.slice(0, idx2).trim();
      buffer2 = buffer2.slice(idx2 + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) waiters2.shift()?.(msg);
    }
  });
  const rpc2 = (method, params, id) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} (instance 2)`)), 10000);
    waiters2.push((msg) => { clearTimeout(timer); resolve(msg); });
    child2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await sleep(1000);
  await rpc2('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke2', version: '0' } }, 1);
  child2.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  const status2 = await rpc2('tools/call', { name: 'get_status', arguments: {} }, 2);
  const status2Text = status2.result?.content?.[0]?.text || '';
  check('second instance relays through hub', status2Text.includes('fake-5.1.4'), status2Text.slice(0, 120));
  child2.kill();

  // Disconnect the fake plugin → tools should return actionable isError, not crash
  ws.close();
  await sleep(300);
  const offline = await rpc('tools/call', { name: 'list_outline', arguments: {} }, 5);
  check('disconnected → isError with guidance', offline.result?.isError === true && /not connected/i.test(offline.result?.content?.[0]?.text || ''));

  console.log(failed ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
} catch (err) {
  console.error('SMOKE TEST ERROR:', err);
  failed = true;
} finally {
  child.kill();
  process.exit(failed ? 1 : 0);
}
