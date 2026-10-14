// Headless mode check (Windows): with BB_HEADLESS=1 the first tool call starts
// Blockbench by itself, its window stays hidden, tools (incl. screenshots) work
// while hidden, and blockbench_window shows/hides it. Also covers the error
// paths: a wrong BB_EXECUTABLE, a launch that never connects, and a running
// Blockbench whose plugin is not on this port.
//
//   Close Blockbench first, then: node scripts/verify-headless.mjs
//
// Set BB_BRIDGE_PORT to the plugin's port. When nothing else listens there, the
// test server is the hub; otherwise it relays through the running hub.
// Leaves Blockbench running with its window shown again.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.BB_BRIDGE_PORT || 8188);
if (process.platform !== 'win32') {
  console.log('SKIP: window hiding is Windows-only.');
  process.exit(0);
}
if (/Blockbench\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq Blockbench.exe', '/NH']).toString())) {
  console.error('Blockbench is running — close it first; this test checks that the server starts it.');
  process.exit(2);
}

function startServer(env) {
  const child = spawn(process.execPath, [path.join(root, 'dist', 'mcp-server.js')], {
    env: { ...process.env, BB_HEADLESS: '1', BB_BRIDGE_PORT: String(PORT), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  let buffer = '';
  const waiters = new Map();
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      waiters.get(msg.id)?.(msg);
      waiters.delete(msg.id);
    }
  });
  const rpc = (method, params, timeoutMs = 180_000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const ready = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-headless', version: '0' } })
    .then(() => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'));
  const tool = async (name, args = {}) => {
    await ready;
    const res = (await rpc('tools/call', { name, arguments: args })).result;
    const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { isError: !!res.isError, text, json, images: res.content.filter((c) => c.type === 'image').length };
  };
  return { tool, log: () => log, kill: () => child.kill() };
}

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = [];
const server = (env) => { const s = startServer(env); servers.push(s); return s; };
try {
  // ── error paths that need no Blockbench ──
  const missing = server({ BB_EXECUTABLE: 'C:\\nowhere\\Blockbench.exe' });
  const m = await missing.tool('list_formats');
  check('wrong BB_EXECUTABLE → clear error', m.isError && /could not find Blockbench at C:\\nowhere/.test(m.text), m.text.slice(0, 160));
  missing.kill();

  // An executable that exits at once stands in for a Blockbench whose plugin never connects.
  const t0 = Date.now();
  const never = server({ BB_EXECUTABLE: 'C:\\Windows\\System32\\whoami.exe', BB_LAUNCH_TIMEOUT_MS: '3000' });
  const n = await never.tool('list_formats');
  check('launch that never connects → timeout error', n.isError && /did not connect within 3 s/.test(n.text), `${Date.now() - t0} ms: ${n.text.slice(0, 120)}`);
  never.kill();

  // ── the real launch: two calls at once share one start ──
  const main = server({});
  const t1 = Date.now();
  const [status, formats] = await Promise.all([main.tool('get_status'), main.tool('list_formats')]);
  check('first tool calls start Blockbench and connect', status.json?.connected === true && status.json?.headless === true && !formats.isError,
    `${Math.round((Date.now() - t1) / 1000)} s`);
  const starts = main.log().match(/starting Blockbench/g)?.length ?? 0;
  check('two concurrent calls start Blockbench once', starts === 1, `${starts} start(s)`);
  console.log(`  (server role: ${/hub: WebSocket server listening/.test(main.log()) ? 'hub' : 'relay client'})`);

  const win = await main.tool('blockbench_window', { action: 'status' });
  check('window is hidden after launch', win.json?.window === 'hidden', win.text);

  await main.tool('create_project', { format: 'bedrock', name: 'headless_check' });
  await main.tool('add_cubes', { cubes: [{ name: 'box', from: [-4, 0, -4], to: [4, 8, 4] }] });
  const shot = await main.tool('capture_screenshot', { angle: 'isometric_right', resolution: 256 });
  check('screenshot renders while hidden', !shot.isError && shot.images === 1, shot.text.slice(0, 160));

  const again = await main.tool('get_status');
  const tabs = again.json?.open_tabs?.map((t) => t.name) ?? [];
  check('later calls reuse the same Blockbench', tabs.includes('headless_check') && main.log().match(/starting Blockbench/g)?.length === 1, JSON.stringify(tabs));

  const shown = await main.tool('blockbench_window', { action: 'show' });
  await sleep(300);
  const afterShow = await main.tool('blockbench_window', { action: 'status' });
  check('show makes the window visible', shown.json?.window === 'visible' && afterShow.json?.window === 'visible', afterShow.text);

  await main.tool('blockbench_window', { action: 'hide' });
  await sleep(300);
  const afterHide = await main.tool('blockbench_window', { action: 'status' });
  check('hide hides it again', afterHide.json?.window === 'hidden', afterHide.text);

  // ── Blockbench runs, but its plugin is on another port: no second launch, a clear error ──
  const other = server({ BB_BRIDGE_PORT: String(PORT + 7) });
  const t2 = Date.now();
  const o = await other.tool('list_formats');
  check('running Blockbench without a plugin on this port → error, no relaunch',
    o.isError && /running but the "Blockbench MCP Bridge" plugin did not connect/.test(o.text) && !/starting Blockbench/.test(other.log()),
    `${Math.round((Date.now() - t2) / 1000)} s: ${o.text.slice(0, 100)}`);
  other.kill();

  await main.tool('blockbench_window', { action: 'show' });
} catch (err) {
  check('no exception', false, err.stack);
} finally {
  for (const s of servers) s.kill();
}
console.log(failed ? `\nFAILED — ${failed} check(s)` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
