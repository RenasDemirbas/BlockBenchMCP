// Call one MCP tool from the shell:
//   node scripts/call-tool.mjs <tool_name> ['<json args>'] [--images <dir>]
//
// Spawns a fresh dist/mcp-server.js (which relays through the running hub), so
// this reaches tools and parameters that an already-open chat session cannot see
// — a session's tool list is fixed when its server process starts.
// --images <dir> writes every image block of the result to <dir>/<tool>_<n>.png.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
let imagesDir = null;
const imgFlag = argv.indexOf('--images');
if (imgFlag >= 0) { imagesDir = argv[imgFlag + 1]; argv.splice(imgFlag, 2); }
const name = argv[0];
if (!name) {
  console.error("usage: node scripts/call-tool.mjs <tool_name> ['<json args>'] [--images <dir>]");
  process.exit(2);
}
let args = {};
if (argv[1]) {
  try { args = JSON.parse(argv[1]); } catch (err) {
    console.error(`arguments must be valid JSON: ${err.message}`);
    process.exit(2);
  }
}

const child = spawn(process.execPath, [path.join(root, 'dist', 'mcp-server.js')], {
  env: { ...process.env, BB_BRIDGE_PORT: process.env.BB_BRIDGE_PORT || '8188' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

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

let code = 0;
try {
  await new Promise((r) => setTimeout(r, 1200));
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'call-tool', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res.result?.content?.find((c) => c.type === 'text')?.text;
  if (text === undefined) console.log(JSON.stringify(res.result ?? res, null, 2));
  else console.log(text);
  if (imagesDir) {
    fs.mkdirSync(imagesDir, { recursive: true });
    let n = 0;
    for (const block of res.result?.content ?? []) {
      if (block.type !== 'image') continue;
      const file = path.join(imagesDir, `${name}_${n++}.png`);
      fs.writeFileSync(file, Buffer.from(block.data, 'base64'));
      console.error(`[image] ${file}`);
    }
  }
  if (res.result?.isError) code = 1;
  if (res.error) { console.error(JSON.stringify(res.error, null, 2)); code = 1; }
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  code = 1;
} finally {
  child.kill();
  process.exit(code);
}
