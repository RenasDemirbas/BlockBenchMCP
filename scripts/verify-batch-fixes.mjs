// Verifies the batch/parent/paint/density fixes against a live Blockbench:
//   * every creating tool rolls back completely when a batch fails partway:
//     no new node survives, no node changes parent, no undo entry is left
//   * the same tools still work on success (parented, one undo step)
//   * "parent" resolves among groups only (a cube named like its group is fine)
//   * paint_texture rect/ellipse: thickness alone draws an outline
//   * pixel_density: honoured up to 512, out of range is an error
//
// Spawns its own dist/mcp-server.js and works in a scratch project tab, so the
// user's models are never touched. eval_code is used only to READ state.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const child = spawn(process.execPath, [path.join(root, 'dist', 'mcp-server.js')], {
  env: { ...process.env, BB_BRIDGE_PORT: process.env.BB_BRIDGE_PORT || '8188' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', () => {});

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
let passes = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${extra !== undefined ? ` — ${String(extra).slice(0, 220)}` : ''}`);
  if (cond) passes++; else failed = true;
};
async function tool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res.result?.content?.find((c) => c.type === 'text')?.text || res.error?.message || '';
  let json = null; try { json = JSON.parse(text); } catch {}
  return { text, json, isError: res.result?.isError === true || !!res.error };
}
async function read(code) {
  const r = await tool('eval_code', { code, undo: false });
  return r.json?.result;
}

// Every node with its parent, plus the undo position: a failed batch must leave all of it as it was.
const STATE = `JSON.stringify({
  nodes: [...Project.groups, ...Project.elements].map((n) => n.uuid + '>' + (n.parent === 'root' ? 'root' : n.parent.uuid) + ':' + n.name).sort(),
  undo: Undo.history.length + '/' + Undo.index,
})`;
const state = async () => JSON.parse(await read(STATE));
const parentOf = async (name) => read(`(() => { const n = [...Project.groups, ...Project.elements].find((x) => x.name === ${JSON.stringify(name)}); return n ? (n.parent === 'root' ? 'root' : n.parent.name) : null; })()`);
const countNamed = async (prefix) => read(`[...Project.groups, ...Project.elements].filter((n) => n.name.startsWith(${JSON.stringify(prefix)})).length`);
const texByName = (name) => `Texture.all.find((t) => t.name.replace(/\\.png$/i, '') === ${JSON.stringify(name)})`;
const pixel = async (tex, x, y) => read(`(() => { const t = ${texByName(tex)}; const d = t.canvas.getContext('2d').getImageData(${x}, ${y}, 1, 1).data; return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join(''); })()`);

// One batch per creating tool: a valid first item, then one that fails.
const CASES = [
  {
    tool: 'add_groups', prefix: 'g_',
    ok: { groups: [{ name: 'g_ok', parent: 'rig' }] },
    bad: { groups: [{ name: 'g_new' }, { name: 'g_bad', parent: 'no_such_group' }] },
  },
  {
    tool: 'add_cubes', prefix: 'c_',
    ok: { cubes: [{ name: 'c_ok', parent: 'rig', from: [0, 0, 0], to: [2, 2, 2] }] },
    bad: { cubes: [{ name: 'c_new', parent: 'rig', from: [0, 4, 0], to: [1, 5, 1] }, { name: 'c_bad', parent: 'no_such_group', from: [0, 0, 0], to: [1, 1, 1] }] },
  },
  {
    tool: 'add_meshes', prefix: 'm_',
    ok: { meshes: [{ name: 'm_ok', parent: 'rig', vertices: { a: [0, 0, 0], b: [4, 0, 0], c: [4, 0, 4], d: [0, 0, 4] }, faces: [{ vertices: ['a', 'b', 'c', 'd'] }] }] },
    bad: { meshes: [
      { name: 'm_new', parent: 'rig', vertices: { a: [0, 1, 0], b: [4, 1, 0], c: [4, 1, 4] }, faces: [{ vertices: ['a', 'b', 'c'] }] },
      { name: 'm_bad', parent: 'no_such_group', vertices: { a: [0, 0, 0], b: [1, 0, 0], c: [1, 0, 1] }, faces: [{ vertices: ['a', 'b', 'c'] }] },
    ] },
  },
  {
    tool: 'add_planes', prefix: 'p_',
    ok: { planes: [{ name: 'p_ok', parent: 'rig', at: [8, 0, 0], width: 4, height: 4 }] },
    bad: { planes: [{ name: 'p_new', parent: 'rig', at: [8, 0, 4] }, { name: 'p_bad', parent: 'no_such_group', at: [8, 0, 8] }] },
  },
  {
    tool: 'add_locators', prefix: 'l_',
    ok: { locators: [{ name: 'l_ok', parent: 'rig', position: [0, 8, 0] }] },
    bad: { locators: [{ name: 'l_new', parent: 'rig', position: [0, 9, 0] }, { name: 'l_bad', parent: 'no_such_group', position: [0, 0, 0] }] },
  },
  {
    tool: 'add_bounding_boxes', prefix: 'b_',
    ok: { boxes: [{ name: 'b_ok', parent: 'rig', from: [-4, 0, -4], to: [4, 8, 4] }] },
    bad: { boxes: [{ name: 'b_new', parent: 'rig', from: [0, 0, 0], to: [1, 1, 1] }, { name: 'b_bad', parent: 'no_such_group', from: [0, 0, 0], to: [1, 1, 1] }] },
  },
  {
    tool: 'add_ik_controllers', prefix: 'ik_',
    ok: { controllers: [{ name: 'ik_ok', target: 'foot', parent: 'rig' }] },
    bad: { controllers: [{ name: 'ik_new', target: 'foot', parent: 'rig' }, { name: 'ik_bad', target: 'no_such_bone', parent: 'rig' }] },
  },
  {
    tool: 'duplicate_elements', prefix: 'c_ok',
    ok: { ids: ['c_ok'] },
    bad: { ids: ['c_ok', 'no_such_element'] },
    okCheck: async () => (await countNamed('c_ok')) === 2,
  },
];

let originalTab = null;
let scratchOpen = false;

try {
  await sleep(1200);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-batch-fixes', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const status = await tool('get_status', {});
  check('connected to Blockbench', status.json?.connected === true, status.json?.blockbench_version);
  if (status.json?.connected !== true) throw new Error('not connected');
  originalTab = status.json?.project?.uuid || null;

  const scratch = await tool('create_project', { format: 'free', name: 'mcp_batchfix_probe' });
  check('scratch project created', !scratch.isError, scratch.text.slice(0, 80));
  scratchOpen = !scratch.isError;

  // A small rig: rig > leg > foot (the IK chain) plus a group named like a cube.
  const rig = await tool('add_groups', { groups: [{ name: 'rig' }, { name: 'leg', parent: 'rig', origin: [0, 8, 0] }, { name: 'foot', parent: 'leg', origin: [0, 2, 0] }] });
  check('rig groups created', !rig.isError && rig.json?.created?.length === 3, rig.text.slice(0, 120));

  // ── 1. rollback + success path, per creating tool ─────────────────────────
  for (const c of CASES) {
    const before = await state();
    const ok = await tool(c.tool, c.ok);
    const okParented = c.okCheck ? await c.okCheck() : (await parentOf(`${c.prefix}ok`)) === 'rig';
    check(`${c.tool}: success path creates and parents`, !ok.isError && okParented, ok.isError ? ok.text : undefined);
    const afterOk = await state();
    check(`${c.tool}: success is one undo step`, afterOk.undo !== before.undo, `${before.undo} -> ${afterOk.undo}`);

    const bad = await tool(c.tool, c.bad);
    const afterBad = await state();
    check(`${c.tool}: failing batch reports an error`, bad.isError, bad.text.slice(0, 120));
    const leaked = afterBad.nodes.filter((n) => !afterOk.nodes.includes(n));
    const lost = afterOk.nodes.filter((n) => !afterBad.nodes.includes(n));
    check(`${c.tool}: failing batch leaves the outliner exactly as it was`, !leaked.length && !lost.length,
      leaked.length || lost.length ? `leaked ${leaked.join(', ')} | lost ${lost.join(', ')}` : undefined);
    check(`${c.tool}: failing batch leaves no undo entry`, afterBad.undo === afterOk.undo, `${afterOk.undo} -> ${afterBad.undo}`);
  }

  // mirror_elements (duplicate): success path, then a failing id
  {
    await tool('add_cubes', { cubes: [{ name: 'arm_left', parent: 'rig', from: [4, 4, 0], to: [6, 8, 2] }] });
    const m = await tool('mirror_elements', { ids: ['arm_left'], axis: 'x', duplicate: true });
    check('mirror_elements: duplicate creates the twin', !m.isError && (await parentOf('arm_right')) === 'rig', m.text.slice(0, 120));
    const before = await state();
    const bad = await tool('mirror_elements', { ids: ['arm_left', 'no_such_element'], axis: 'x', duplicate: true });
    const after = await state();
    check('mirror_elements: failing call changes nothing', bad.isError && JSON.stringify(before) === JSON.stringify(after), bad.text.slice(0, 120));
  }

  // undo of a successful batch removes the whole batch in one step
  {
    const before = await state();
    await tool('add_cubes', { cubes: [{ name: 'u_1', parent: 'rig', from: [0, 0, 8], to: [1, 1, 9] }, { name: 'u_2', parent: 'leg', from: [0, 0, 9], to: [1, 1, 10] }] });
    await tool('undo', {});
    const after = await state();
    check('undo removes a whole add_cubes batch', JSON.stringify(before.nodes) === JSON.stringify(after.nodes), after.nodes.filter((n) => !before.nodes.includes(n)).join(', '));
  }

  // ── 2. parent resolves among groups only ──────────────────────────────────
  {
    await tool('add_groups', { groups: [{ name: 'floor' }] });
    const r = await tool('add_cubes', { cubes: [
      { name: 'floor', parent: 'floor', from: [0, 0, 0], to: [8, 0.2, 8] },
      { name: 'apron', parent: 'floor', from: [0, 0, 8], to: [8, 0.1, 10] },
    ] });
    check('cube named like its group: both cubes land in the group', !r.isError && (await parentOf('apron')) === 'floor'
      && (await read(`Project.elements.filter((e) => e.name === 'floor' && e.parent?.name === 'floor').length`)) === 1, r.text.slice(0, 160));
    // Bone-rig formats keep group names unique (a second "floor" becomes "floor2"), so a tool can't make
    // two groups share a name here; if a format ever allows it, the name must fail instead of guessing.
    await tool('add_groups', { groups: [{ name: 'floor', parent: 'rig' }] });
    const sameName = await read(`Project.groups.filter((g) => g.name === 'floor').length`);
    const amb = await tool('add_cubes', { cubes: [{ name: 'amb', parent: 'floor', from: [0, 0, 0], to: [1, 1, 1] }] });
    if (sameName > 1) check('two groups with one name: clear error', amb.isError && /Multiple groups are named "floor"/.test(amb.text), amb.text.slice(0, 160));
    else check('second group got a unique name; "floor" still means the first group', !amb.isError && (await read(`Project.elements.find((e) => e.name === 'amb').parent.parent`)) === 'root', amb.text.slice(0, 160));
    const asCube = await tool('add_cubes', { cubes: [{ name: 'x', parent: 'apron', from: [0, 0, 0], to: [1, 1, 1] }] });
    check('a cube as parent is still refused', asCube.isError && /not a group/.test(asCube.text), asCube.text.slice(0, 160));
  }

  // ── 3. rect / ellipse outline vs fill ─────────────────────────────────────
  {
    await tool('create_texture', { name: 'ops32', width: 32, height: 32, fill_color: '#ffffff' });
    const p = await tool('paint_texture', { texture: 'ops32', ops: [
      { type: 'rect', from: [2, 2], to: [13, 13], thickness: 2, color: '#000000' },
      { type: 'rect', from: [18, 2], to: [29, 13], color: '#ff0000' },
      { type: 'rect', from: [2, 18], to: [13, 29], thickness: 2, filled: true, color: '#0000ff' },
      { type: 'ellipse', center: [24, 24], radius: [6, 6], thickness: 1, color: '#00ff00' },
    ] });
    check('paint ops applied', !p.isError, p.text.slice(0, 120));
    check('rect + thickness: edge painted', (await pixel('ops32', 2, 7)) === '#000000');
    check('rect + thickness: 2 px wide', (await pixel('ops32', 3, 7)) === '#000000' && (await pixel('ops32', 4, 7)) === '#ffffff');
    check('rect + thickness: inside stays empty', (await pixel('ops32', 7, 7)) === '#ffffff');
    check('rect without thickness: filled', (await pixel('ops32', 23, 7)) === '#ff0000');
    check('rect + thickness + filled:true: filled', (await pixel('ops32', 7, 23)) === '#0000ff');
    check('ellipse + thickness: ring, hollow centre', (await pixel('ops32', 24, 18)) === '#00ff00' && (await pixel('ops32', 24, 24)) === '#ffffff');
    const fill = await tool('paint_texture', { texture: 'ops32', ops: [{ type: 'ellipse', center: [24, 24], radius: [3, 3], color: '#00ff00' }] });
    check('ellipse without thickness: filled', !fill.isError && (await pixel('ops32', 24, 24)) === '#00ff00');
  }

  // ── 4. pixel_density ──────────────────────────────────────────────────────
  {
    // tpl is 2 units wide: at 256 (16 px per unit) its north face is 32 px wide; at the old clamp (128) it was 16
    await tool('add_cubes', { cubes: [{ name: 'tpl', from: [20, 0, 0], to: [22, 2, 2] }] });
    const t256 = await tool('generate_texture_template', { name: 'pd256', elements: ['tpl'], pixel_density: 256 });
    const faceWidth = await read(`(() => { const c = Project.elements.find((e) => e.name === 'tpl'); const t = c.faces.north.getTexture(); const f = c.faces.north; return Math.abs(f.uv[2] - f.uv[0]) * t.width / t.getUVWidth(); })()`);
    check('generate_texture_template: pixel_density 256 = 16 px per unit', !t256.isError && Math.abs(faceWidth - 32) < 0.5, `north face ${faceWidth} px wide (want 32)`);
    const t600 = await tool('generate_texture_template', { name: 'pd600', elements: ['tpl'], pixel_density: 600 });
    check('generate_texture_template: 600 is refused with the range', t600.isError && /1-512/.test(t600.text), t600.text.slice(0, 120));
    const t0 = await tool('generate_texture_template', { name: 'pd0', elements: ['tpl'], pixel_density: 0 });
    check('generate_texture_template: 0 is refused with the range', t0.isError && /1-512/.test(t0.text), t0.text.slice(0, 120));

    const u64 = await tool('unwrap_mesh', { elements: ['m_ok'], pixel_density: 64, name: 'uw64' });
    check('unwrap_mesh: pixel_density 64 = 4 px per unit', !u64.isError && Math.abs((u64.json?.texel_density?.median ?? 0) - 4) < 0.3, JSON.stringify(u64.json?.texel_density));
    const u256 = await tool('unwrap_mesh', { elements: ['m_ok'], pixel_density: 256, name: 'uw256' });
    check('unwrap_mesh: pixel_density 256 = 16 px per unit (was clamped to 8)', !u256.isError && Math.abs((u256.json?.texel_density?.median ?? 0) - 16) < 1, JSON.stringify(u256.json?.texel_density));
    const u999 = await tool('unwrap_mesh', { elements: ['m_ok'], pixel_density: 999 });
    check('unwrap_mesh: 999 is refused with the range', u999.isError && /1-512/.test(u999.text), u999.text.slice(0, 120));
  }

  console.log(failed ? `\nBATCH FIXES VERIFY FAILED (${passes} passed)` : `\nBATCH FIXES VERIFY PASSED (${passes} checks)`);
} catch (err) {
  console.error('VERIFY ERROR:', err.message);
  failed = true;
} finally {
  try {
    if (scratchOpen) await tool('project_file', { action: 'close', force: true });
    if (originalTab) await tool('project_file', { action: 'switch_tab', uuid: originalTab });
  } catch (err) {
    console.error('cleanup failed:', err.message);
  }
  child.kill();
  process.exit(failed ? 1 : 0);
}
