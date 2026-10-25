// Write the website's tools.json: every tool's name, title, description, input schema and hints,
// straight from the built server (tools/list), so the reference never drifts from the code.
//   node scripts/site-data.mjs [out-file]   (default _site/data/tools.json; scripts/build-site.mjs runs it)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const child = spawn(process.execPath, [path.join(root, 'dist', 'mcp-server.js')], {
  env: { ...process.env, BB_BRIDGE_PORT: process.env.BB_BRIDGE_PORT || '8188' },
  stdio: ['pipe', 'pipe', 'ignore'],
});

let buffer = '';
const waiters = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      waiters.get(msg.id)?.(msg);
    } catch { /* not JSON-RPC */ }
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000);
  waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

try {
  await new Promise((r) => setTimeout(r, 800));
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'site-data', version: pkg.version } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const { result } = await rpc('tools/list', {});
  const tools = result.tools.map((t) => ({
    name: t.name,
    title: t.title ?? t.annotations?.title ?? t.name,
    description: t.description,
    readOnly: !!t.annotations?.readOnlyHint,
    destructive: !!t.annotations?.destructiveHint,
    input: t.inputSchema,
  }));
  const out = path.resolve(process.argv[2] ?? path.join(root, '_site', 'data', 'tools.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ version: pkg.version, tools }, null, 1));
  console.log(`wrote ${path.relative(root, out)}: ${tools.length} tools`);
} finally {
  child.kill();
}
