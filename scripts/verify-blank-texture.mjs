// Read-only verification against the live project: does the MCP now EXPLAIN a
// blank-looking render (transparent texture) instead of just returning a white
// PNG? Spawns a fresh server process so the v1.1 tool schemas are in play.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'e2e-output', 'blank-texture');
fs.mkdirSync(outDir, { recursive: true });

const child = spawn(process.execPath, [path.join(root, 'dist', 'mcp-server.js')], {
  env: { ...process.env, BB_BRIDGE_PORT: process.env.BB_BRIDGE_PORT || '8188' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stdout.write(`[server] ${d}`));

let buffer = '';
const waiters = new Map();
let nextId = 1;
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    } catch {}
  }
});
const rpc = (method, params, timeoutMs = 120000) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${extra ? ` — ${String(extra).slice(0, 300)}` : ''}`);
  if (!cond) failed = true;
};

async function tool(name, args, file) {
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res.result?.content?.find((c) => c.type === 'text')?.text || '';
  const images = (res.result?.content || []).filter((c) => c.type === 'image');
  if (file && images[0]) {
    fs.writeFileSync(path.join(outDir, file), Buffer.from(images[0].data, 'base64'));
    console.log(`   [image saved] ${path.join(outDir, file)}`);
  }
  let json = null; try { json = JSON.parse(text); } catch {}
  return { text, json, images, isError: res.result?.isError === true };
}

try {
  await sleep(1200);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const status = await tool('get_status', {});
  check('connected to Blockbench', status.json?.connected === true, status.json?.project?.name);

  const shot = await tool('capture_screenshot', { angle: 'isometric_right', resolution: 420, background: '#232838' }, 'with_background.png');
  check('screenshot returns a coverage figure', typeof shot.json?.coverage === 'number', `coverage=${shot.json?.coverage}`);
  check('screenshot WARNS about the transparent texture', /FULLY TRANSPARENT/.test(shot.json?.warning || ''), shot.json?.warning);

  const val = await tool('validate_model', { intersections: false });
  const finding = (val.json?.findings || []).find((f) => f.type === 'transparent_texture');
  check('validate_model reports transparent_texture as an error', finding?.level === 'error', JSON.stringify(finding));

  const tex = await tool('get_texture', { max_size: 128 }, 'texture.png');
  check('get_texture reports visible_pixels = 0 + warning', tex.json?.visible_pixels === 0 && /FULLY TRANSPARENT/.test(tex.json?.warning || ''), `visible_pixels=${tex.json?.visible_pixels}`);

  console.log(failed ? '\nVERIFY FAILED' : '\nVERIFY PASSED');
} catch (err) {
  console.error('VERIFY ERROR:', err.message);
  failed = true;
} finally {
  child.kill();
  process.exit(failed ? 1 : 0);
}
