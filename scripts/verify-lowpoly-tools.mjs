// scratch project tab so the user's model is never touched.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${extra !== undefined ? ` — ${String(extra).slice(0, 220)}` : ''}`);
  if (!cond) failed = true;
};
async function tool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res.result?.content?.find((c) => c.type === 'text')?.text || '';
  let json = null; try { json = JSON.parse(text); } catch {}
  return { text, json, isError: res.result?.isError === true };
}

let originalTab = null;
/** Run JS inside Blockbench and return its value. */
async function bb(code) {
  const r = await tool('eval_code', { code, undo: false });
  return r.json?.result ?? r.json ?? r.text;
}
const only = process.argv[2] ? process.argv[2].split(',') : null;
const want = (section) => !only || only.includes(section);

try {
  await sleep(1200);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-lowpoly-tools', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  const status = await tool('get_status', {});
  check('connected to Blockbench', status.json?.connected === true, status.json?.blockbench_version);
  if (status.json?.connected !== true) throw new Error('not connected');

  const scratch = await tool('create_project', { format: 'free', name: 'mcp_lowpoly_probe' });
  check('scratch project created', !scratch.isError, scratch.text.slice(0, 80));

  // ── 1. mesh painting ──────────────────────────────────────────────────────
  if (want('paint')) {
    const prim = await tool('add_mesh_primitive', { shape: 'cylinder', sides: 6, diameter: 8, height: 16, name: 'barrel' });
    check('cylinder mesh added', !prim.isError, prim.text.slice(0, 100));
    await tool('add_cubes', { cubes: [{ name: 'box', from: [8, 0, 0], to: [12, 4, 4] }] });
    const tpl = await tool('generate_texture_template', { pixel_density: 16, name: 'probe_tex' });
    check('template generated', !tpl.isError, tpl.text.slice(0, 120));

    const pf = await tool('paint_faces', { targets: [{ element: 'barrel', faces: 'all', color: '#3060c0' }, { element: 'barrel', faces: ['up'], color: '#ff0000' }] });
    check('paint_faces on a mesh (all + direction "up")', !pf.isError && pf.json?.painted >= 7, pf.text.slice(0, 200));

    const up = await bb(`(() => { const m = Mesh.all.find(m => m.name === 'barrel'); const tex = Texture.all[0];
      const fk = Object.keys(m.faces).find(k => { const f = m.faces[k]; return f.vertices.length > 4; } ) || Object.keys(m.faces).find(k => m.faces[k].getNormal(true)[1] > 0.9);
      const f = m.faces[fk]; const vs = f.vertices; const fx = tex.width / tex.getUVWidth();
      let cx = 0, cy = 0; vs.forEach(v => { cx += f.uv[v][0]; cy += f.uv[v][1]; }); cx = Math.floor(cx / vs.length * fx); cy = Math.floor(cy / vs.length * fx);
      const d = tex.canvas.getContext('2d').getImageData(cx, cy, 1, 1).data; return [fk, d[0], d[1], d[2], d[3]]; })()`);
    check('mesh top face centre is red', Array.isArray(up) && up[1] > 200 && up[2] < 40, JSON.stringify(up));

    const grad = await tool('paint_texture', { ops: [{ type: 'gradient', space: 'world', target: { element: 'barrel', faces: ['north', 'south', 'east', 'west'] }, stops: [{ at: 0, color: '#ffffff' }, { at: 1, color: '#000000' }] }] });
    check('world gradient over mesh side faces', !grad.isError && grad.json?.ops_applied >= 4, grad.text.slice(0, 160));

    const rect = await tool('paint_texture', { ops: [{ type: 'rect', target: { element: 'barrel', faces: ['north'] }, from: [0, 0], to: [1, 1], color: '#00ff00' }] });
    check('rect clipped to mesh face polygon', !rect.isError, rect.text.slice(0, 160));
    const red = await bb(`(() => { const m = Mesh.all.find(m => m.name === 'barrel'); const tex = Texture.all[0];
      const fk = Object.keys(m.faces).find(k => m.faces[k].getNormal(true)[1] > 0.9);
      const f = m.faces[fk]; const fx = tex.width / tex.getUVWidth(); let cx = 0, cy = 0; f.vertices.forEach(v => { cx += f.uv[v][0]; cy += f.uv[v][1]; });
      const d = tex.canvas.getContext('2d').getImageData(Math.floor(cx / f.vertices.length * fx), Math.floor(cy / f.vertices.length * fx), 1, 1).data; return [d[0], d[1]]; })()`);
    check('top face untouched by the north-face rect (pixel clipping)', Array.isArray(red) && red[0] > 200 && red[1] < 40, JSON.stringify(red));

    const crop = await tool('get_texture', { element: 'barrel', faces: ['up'] });
    check('get_texture crops to a mesh face', !crop.isError && crop.json?.cropped_to, JSON.stringify(crop.json?.cropped_to)?.slice(0, 160));

    const insp = await tool('inspect_uv', {});
    check('inspect_uv reports meshes + texel density', !insp.isError && insp.json?.mesh_faces > 0 && insp.json?.texel_density, JSON.stringify({ m: insp.json?.mesh_faces, d: insp.json?.texel_density, f: insp.json?.findings?.map((f) => f.type) }));
  }
} catch (err) {
  check('no exception', false, err.stack || err.message);
} finally {
  try { await tool('close_project', { force: true }); } catch {}
  child.kill();
  console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}
