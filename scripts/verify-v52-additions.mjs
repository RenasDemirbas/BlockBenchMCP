// Integration test for the tools built on Blockbench 5.2 additions:
// armatures + vertex weights, armature IK, transform_mesh falloff, PBR map
// generation, seam blending, playhead keyframe selection, the molang format
// flag, Java parent chains, video reference controls and view_mode captures.
// Blockbench 5.2+ must be running.
//
//   node scripts/verify-v52-additions.mjs
//
// Every check runs in its own scratch project, closed at the end; the tab that
// was selected on entry is restored. The video check needs ffmpeg on PATH.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [path.join(root, 'dist', 'mcp-server.js')], {
  env: { ...process.env, BB_BRIDGE_PORT: process.env.BB_BRIDGE_PORT || '8188' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => { if (/error/i.test(String(d))) process.stderr.write(`[server] ${d}`); });

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

async function tool(name, args = {}) {
  const res = await rpc('tools/call', { name, arguments: args });
  if (res.error) return { ok: false, text: JSON.stringify(res.error), data: null, content: [] };
  const text = res.result?.content?.find((c) => c.type === 'text')?.text ?? '';
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { ok: !res.result?.isError, text, data, content: res.result?.content ?? [] };
}
const evalJs = async (code) => (await tool('eval_code', { code, undo: false })).data?.result;

let passed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;
const scratch = [];
async function newProject(format, extra = {}) {
  const name = `mcp52b_${format}_${Date.now().toString(36)}`;
  const res = await tool('create_project', { format, name, ...extra });
  if (res.ok) scratch.push(res.data?.uuid);
  return res;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbmcp-52b-'));
/** A round tube along +Y from y0 to y1, rings every 2 units. */
const tube = (name, y0, y1, x = 0) => ({
  name, profile: 'round', sides: 8,
  rings: Array.from({ length: Math.round((y1 - y0) / 2) + 1 }, (_, i) => ({ at: [x, y0 + i * 2, 0], size: [4, 4] })),
});

try {
  await new Promise((r) => setTimeout(r, 1200));
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-v52b', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const status = await tool('get_status');
  if (!status.data?.connected) throw new Error('Blockbench is not connected — start it and enable the MCP bridge plugin.');
  const originalTab = status.data.open_tabs?.find((t) => t.selected)?.uuid ?? null;
  console.log(`Blockbench ${status.data.blockbench_version}, plugin ${status.data.plugin_version}\n`);

  console.log('0. feature detection');
  const f = status.data.features || {};
  for (const key of ['armature_ik', 'auto_vertex_weights', 'pbr_materials', 'molang_format_flag']) check(`feature ${key}`, f[key] === true, JSON.stringify(f));

  // ── 1. armature + weights ────────────────────────────────────────────────
  console.log('\n1. armature & vertex weights');
  await newProject('free');
  await tool('add_loft', tube('leg', 0, 16));
  const rig = await tool('add_armature', {
    name: 'rig',
    bones: [
      { name: 'thigh', head: [0, 16, 0], tail: [0, 8, 0] },
      { name: 'shin', parent: 'thigh', head: [0, 8, 0], tail: [0, 1, 0], connected: true },
      { name: 'foot', parent: 'shin', head: [0, 1, 0], tail: [0, 1, -4], connected: true },
    ],
    meshes: ['leg'],
  });
  const bones = rig.data?.bones ?? [];
  check('bones placed at their heads and tails', rig.ok && bones.length === 3 && near(bones[1].head[1], 8, 1e-3) && near(bones[2].tail[2], -4, 1e-3), rig.text.slice(0, 300));
  const w0 = rig.data?.weights?.[0];
  check('attached mesh is skinned with every vertex weighted', w0?.unweighted === 0 && Object.keys(w0?.per_bone ?? {}).length >= 2, JSON.stringify(w0));
  const capWeights = await evalJs(`const m = Mesh.all.find(m => m.name == 'leg'); const thigh = ArmatureBone.all.find(b => b.name == 'thigh');
    return Object.keys(m.vertices).filter(k => m.vertices[k][1] > 15.9).map(k => thigh.getVertexWeight(m, k));`);
  check('top cap (incl. its centre) follows the thigh', Array.isArray(capWeights) && capWeights.length > 0 && capWeights.every((w) => w > 0.99), JSON.stringify(capWeights));
  const outline = await tool('list_outline', {});
  const armNode = outline.data?.root?.find((n) => n.type === 'armature');
  check('list_outline nests bones and the mesh under the armature', !!armNode && Array.isArray(armNode.children) && armNode.children.some((c) => c.name === 'thigh' && Array.isArray(c.children)) && armNode.children.some((c) => c.name === 'leg'), JSON.stringify(armNode)?.slice(0, 300));
  const shinEl = await tool('get_element', { id: 'shin' });
  check('get_element reports a bone head in model space', near(shinEl.data?.head?.[1] ?? -1, 8, 1e-3) && shinEl.data?.weighted_vertices > 0, shinEl.text.slice(0, 200));

  const set = await tool('vertex_weights', { action: 'set', mesh: 'leg', bone: 'shin', weight: 1, select: { where: { axis: 'y', max: 3 } } });
  check('set (replace) on a slab', set.ok && set.data?.set?.vertices > 0, set.text.slice(0, 200));
  const smooth = await tool('vertex_weights', { action: 'smooth', mesh: 'leg', near: { bone: 'shin', distance: 3 }, iterations: 3 });
  check('smooth near the knee blends two bones', smooth.ok && smooth.data?.meshes?.[0]?.max_influences >= 2, smooth.text.slice(0, 300));
  const env = await tool('vertex_weights', { action: 'auto', mesh: 'leg', method: 'envelope', blend: 2 });
  check('envelope auto weights every vertex', env.ok && env.data?.meshes?.[0]?.unweighted === 0, env.text.slice(0, 300));
  const cleared = await tool('vertex_weights', { action: 'clear', mesh: 'leg', bone: 'foot' });
  check('clear one bone', cleared.ok && !cleared.data?.meshes?.[0]?.per_bone?.foot, cleared.text.slice(0, 300));
  await tool('undo', {});
  const back = await tool('vertex_weights', { action: 'inspect', mesh: 'leg' });
  check('weight edits are undoable', back.ok && !!back.data?.meshes?.[0]?.per_bone?.foot, back.text.slice(0, 300));
  const notSkinned = await tool('vertex_weights', { action: 'inspect', mesh: 'thigh' });
  check('a bone passed as mesh fails with a hint', !notSkinned.ok && /not a mesh/.test(notSkinned.text), notSkinned.text.slice(0, 160));

  const weightShot = await tool('capture_screenshot', { angle: 'east', view_mode: 'weighted_bone_colors', resolution: 256 });
  const viewAfter = await evalJs('return BarItems.view_mode.value');
  check('capture in weighted_bone_colors, then the view mode is restored', weightShot.ok && weightShot.content.some((c) => c.type === 'image') && viewAfter === 'textured', `${weightShot.text.slice(0, 120)} / ${viewAfter}`);

  await tool('create_animation', { name: 'pose', length: 1 });
  await tool('set_keyframes', { animation: 'pose', bones: [{ bone: 'shin', channel: 'rotation', keyframes: [{ time: 0, values: [60, 0, 0] }] }] });
  const bent = await evalJs(`Animator.preview(); const m = Mesh.all.find(m => m.name == 'leg'); const off = m.getArmature().calculateVertexDeformation(m);
    const k = Object.keys(m.vertices).find(k => m.vertices[k][1] < 0.1); return off[k];`);
  check('posing the shin moves the skinned foot vertices', Array.isArray(bent) && Math.hypot(...bent) > 2, JSON.stringify(bent));

  const ik = await tool('add_ik_controllers', { controllers: [{ name: 'foot_ik', target: 'foot', source: 'thigh', pole_offset: [0, 0, -8], animations: ['pose'] }] });
  check('IK chain over armature bones', ik.ok && JSON.stringify(ik.data?.controllers?.[0]?.chain) === JSON.stringify(['thigh', 'shin', 'foot']), ik.text.slice(0, 300));
  const ikDefault = await tool('add_ik_controllers', { controllers: [{ name: 'foot_ik2', target: 'foot' }] });
  check('armature IK without source starts at the top bone', ikDefault.ok && /top bone/.test(ikDefault.data?.controllers?.[0]?.note ?? ''), ikDefault.text.slice(0, 300));
  const ikTop = await tool('add_ik_controllers', { controllers: [{ name: 'bad', target: 'thigh' }] });
  check('IK on the top bone is refused', !ikTop.ok && /top bone/.test(ikTop.text), ikTop.text.slice(0, 160));

  const noArm = await newProject('bedrock');
  const refused = noArm.ok && await tool('add_armature', { bones: [{ name: 'a', head: [0, 0, 0] }] });
  check('formats without armatures are refused', refused && !refused.ok && /no armatures/.test(refused.text), refused?.text?.slice(0, 160));

  // ── 2. transform_mesh falloff ────────────────────────────────────────────
  console.log('\n2. transform_mesh falloff');
  await newProject('free');
  await tool('add_loft', tube('pillar', 0, 16));
  await tool('add_loft', tube('twin', 0, 16, 5));
  await tool('edit_mesh', { mesh: 'pillar', steps: [{ op: 'merge_meshes', meshes: ['twin'] }] });
  const rest = (await tool('get_element', { id: 'pillar' })).data.vertices;
  const keysWhere = (pred) => Object.keys(rest).filter((k) => pred(rest[k]));
  const topKeys = keysWhere((p) => p[1] > 15.9 && p[0] < 2.5); // top ring of the left tube
  const dz = async () => {
    const now = (await tool('get_element', { id: 'pillar' })).data.vertices;
    return (keys) => keys.map((k) => Math.abs(now[k][2] - rest[k][2]));
  };
  const move = (falloff) => tool('transform_mesh', { mesh: 'pillar', select: { vertices: topKeys }, ops: [{ type: 'move', offset: [0, 0, 4] }], falloff });
  const r1 = await move({ radius: 8, distance: 'linear' });
  const d1 = await dz();
  const mid = d1(keysWhere((p) => Math.abs(p[1] - 12) < 0.01 && p[0] < 2.5));
  check('falloff drags nearby vertices part of the way', r1.ok && r1.data?.transformed?.[0]?.falloff_vertices > 0 && mid.every((d) => d > 0.5 && d < 3.5), `${r1.text.slice(0, 160)} ${JSON.stringify(mid)}`);
  check('…but not beyond the radius', d1(keysWhere((p) => p[1] < 0.1 && p[0] < 2.5)).every((d) => d < 1e-6), '');
  check('linear distance reaches the separate tube next to it', d1(keysWhere((p) => p[1] > 15.9 && p[0] > 2.5)).some((d) => d > 0.1), '');
  await tool('undo', {});
  await move({ radius: 8, distance: 'connected' });
  const d2 = await dz();
  check('connected distance leaves the separate tube alone', d2(keysWhere((p) => p[0] > 2.5)).every((d) => d < 1e-6) && d2(topKeys).every((d) => near(d, 4, 1e-6)), '');
  const badFalloff = await tool('transform_mesh', { mesh: 'pillar', ops: [{ type: 'move', offset: [1, 0, 0] }], falloff: { radius: -1 } });
  check('invalid falloff radius is refused', !badFalloff.ok && /radius/.test(badFalloff.text), badFalloff.text.slice(0, 120));

  // ── 3. PBR maps ──────────────────────────────────────────────────────────
  console.log('\n3. generate_pbr_map');
  await newProject('free');
  await tool('add_cubes', { cubes: [{ name: 'crate', from: [-8, 0, -8], to: [8, 16, 8] }] });
  await tool('create_texture', { name: 'crate', width: 16, height: 16, fill_color: '#808080', apply_to_all: true });
  await tool('paint_texture', { texture: 'crate', ops: [{ type: 'rect', from: [0, 0], to: [7, 15], color: '#ffffff' }, { type: 'rect', from: [12, 0], to: [15, 15], color: '#ff2020' }] });
  const presets = await tool('generate_pbr_map', { list_presets: true });
  check('built-in presets listed', presets.ok && presets.data?.built_in?.some((p) => p.name === 'normal_from_brightness'), presets.text.slice(0, 160));
  const pbr = await tool('generate_pbr_map', { texture: 'crate', maps: [{ preset: 'normal_from_brightness' }, { preset: 'roughness_matte' }, { preset: 'metal_from_grey' }] });
  const names = pbr.data?.textures?.map((t) => `${t.name}:${t.pbr_channel}`) ?? [];
  check('normal + MER textures created in a new material', pbr.ok && /material/.test(pbr.data?.note ?? '') && names.some((n) => n.endsWith(':normal')) && names.some((n) => n.endsWith(':mer')), pbr.text.slice(0, 300));
  const mer = await evalJs(`const t = Texture.all.find(t => t.pbr_channel == 'mer'); const d = t.canvas.getContext('2d').getImageData(0, 0, 16, 16).data;
    return { grey: Array.from(d.slice((5*16+9)*4, (5*16+9)*4+4)), red: Array.from(d.slice((5*16+13)*4, (5*16+13)*4+4)), group: t.getGroup()?.is_material };`);
  check('MER: grey is metal, red is not; roughness in blue', mer?.group === true && mer.grey[0] > 200 && mer.red[0] < 60 && mer.grey[2] >= 150, JSON.stringify(mer));
  const normal = await evalJs(`const t = Texture.all.find(t => t.pbr_channel == 'normal'); const d = t.canvas.getContext('2d').getImageData(0, 0, 16, 16).data;
    return [Array.from(d.slice((5*16+3)*4, (5*16+3)*4+3)), Array.from(d.slice((5*16+7)*4, (5*16+7)*4+3))];`);
  check('normal map tilts at the white/grey edge and is flat inside', Array.isArray(normal) && near(normal[0][0], 127, 1) && normal[1][0] > 127 + 30 && normal[0][2] === 255, JSON.stringify(normal));
  const rerun = await tool('generate_pbr_map', { texture: 'crate', maps: [{ channel: 'roughness', method: 'empty', out_range: [0, 0] }] });
  const mer2 = await evalJs(`const t = Texture.all.filter(t => t.pbr_channel == 'mer'); const d = t[0].canvas.getContext('2d').getImageData(0, 0, 16, 16).data; return { count: t.length, px: Array.from(d.slice((5*16+9)*4, (5*16+9)*4+4)) };`);
  check('re-running one channel keeps the others and reuses the texture', rerun.ok && mer2?.count === 1 && mer2.px[0] > 200 && mer2.px[2] === 0, JSON.stringify(mer2));
  const badPreset = await tool('generate_pbr_map', { texture: 'crate', maps: [{ preset: 'nope' }] });
  check('unknown preset lists the valid ones', !badPreset.ok && /normal_from_brightness/.test(badPreset.text), badPreset.text.slice(0, 160));
  const fromMap = await tool('generate_pbr_map', { texture: names.find((n) => n.endsWith(':normal'))?.split(':')[0] });
  check('a PBR map is refused as the source', !fromMap.ok && /colour texture/.test(fromMap.text), fromMap.text.slice(0, 160));
  const matShot = await tool('capture_screenshot', { view_mode: 'material', resolution: 256 });
  check('capture in material view mode', matShot.ok && matShot.content.some((c) => c.type === 'image'), matShot.text.slice(0, 120));

  // ── 4. blend_seams ───────────────────────────────────────────────────────
  console.log('\n4. blend_seams');
  await newProject('bedrock');
  await tool('add_cubes', { cubes: [{ name: 'left', from: [-8, 0, -4], to: [0, 8, 4] }, { name: 'right', from: [0, 0, -4], to: [8, 8, 4] }, { name: 'far', from: [20, 0, -4], to: [28, 8, 4] }] });
  await tool('generate_texture_template', { pixel_density: 16 });
  await tool('paint_faces', { targets: [{ element: 'left', color: '#ff0000' }, { element: 'right', color: '#0000ff' }, { element: 'far', color: '#00ff00' }] });
  const farOnly = await tool('blend_seams', { elements: ['far'], between: 'elements' });
  check('a lone cube has no seams between elements', farOnly.ok && farOnly.data?.texels_blended === 0, farOnly.text.slice(0, 200));
  const blended = await tool('blend_seams', { elements: ['left', 'right'], between: 'elements', width: 2, strength: 1, layer: 'seams' });
  check('touching cubes blend across their joint', blended.ok && blended.data?.texels_blended > 0 && blended.data?.faces_touched >= 4, blended.text.slice(0, 300));
  // The red cube's north face touches the blue cube along x = 0: one of its
  // two side columns is that joint (which one depends on the UV direction).
  const mixed = await evalJs(`const c = Cube.all.find(c => c.name == 'left'); const f = c.faces.north; const t = f.getTexture(); const s = t.width / t.getUVWidth();
    const y = Math.floor((f.uv[1] + f.uv[3]) / 2 * s), xs = [Math.floor(Math.min(f.uv[0], f.uv[2]) * s), Math.floor(Math.max(f.uv[0], f.uv[2]) * s) - 1];
    const l = t.layers.find(l => l.name == 'seams'); return xs.map(x => Array.from(l.ctx.getImageData(x, y, 1, 1).data));`);
  const purple = (px) => px[0] > 60 && px[2] > 60 && px[3] === 255;
  check('the joint column of the red cube turned purple (in the "seams" layer); the free side did not', Array.isArray(mixed) && mixed.filter(purple).length === 1 && mixed.some((px) => px[3] === 0), JSON.stringify(mixed));
  const corners = await tool('blend_seams', { elements: ['far'], between: 'faces', max_angle: 100 });
  check('one flat-coloured cube: corners have nothing to blend', corners.ok && corners.data?.texels_blended === 0, corners.text.slice(0, 200));

  // ── 5. edit_keyframes relative to the playhead ──────────────────────────
  console.log('\n5. edit_keyframes before/after playhead');
  await tool('add_groups', { groups: [{ name: 'body' }] });
  await tool('create_animation', { name: 'clip', length: 1 });
  await tool('set_keyframes', { animation: 'clip', bones: [{ bone: 'body', channel: 'rotation', keyframes: [{ time: 0, values: [0, 0, 0] }, { time: 0.5, values: [10, 0, 0] }, { time: 1, values: [0, 0, 0] }] }] });
  const after = await tool('edit_keyframes', { animation: 'clip', relative_to_playhead: 'after', playhead: 0.4, delete: true });
  const left = await tool('get_animation', { animation: 'clip' });
  check('delete after the playhead', after.ok && after.data?.deleted === 2 && /"time": 0\b/.test(left.text) && !/"time": 1\b/.test(left.text), after.text.slice(0, 200));
  const before = await tool('edit_keyframes', { animation: 'clip', relative_to_playhead: 'before', playhead: 0, delete: true });
  check('nothing strictly before t=0', !before.ok && /before playhead/.test(before.text), before.text.slice(0, 200));

  // ── 6. molang format flag ────────────────────────────────────────────────
  console.log('\n6. molang format flag');
  const formats = await tool('list_formats', {});
  const fmt = (id) => Object.values(formats.data ?? {}).find((x) => x.id === id)?.capabilities;
  check('free has molang, java_block does not', fmt('free')?.molang === true && fmt('java_block')?.molang === false, JSON.stringify([fmt('free'), fmt('java_block')]));

  // ── 7. Java parent chains ────────────────────────────────────────────────
  console.log('\n7. Java child models');
  const models = path.join(tmp, 'pack', 'assets', 'test', 'models', 'block');
  fs.mkdirSync(models, { recursive: true });
  fs.writeFileSync(path.join(models, 'base.json'), JSON.stringify({ textures: { all: 'test:block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { up: { texture: '#all' } } }] }));
  fs.writeFileSync(path.join(models, 'child.json'), JSON.stringify({ parent: 'test:block/base', textures: { all: 'test:block/dirt' } }));
  const resolved = await tool('project_file', { action: 'open', path: path.join(models, 'child.json') });
  if (resolved.ok) scratch.push(resolved.data?.uuid);
  const resolvedCubes = await evalJs('return { cubes: Cube.all.length, dialog: !!Dialog.open }');
  check('resolve_parents (default) merges the parent chain, no dialog', resolved.ok && resolvedCubes?.cubes === 1 && !resolvedCubes.dialog, JSON.stringify(resolvedCubes));
  // A file that is already open only re-selects its tab, so close the first one.
  await tool('project_file', { action: 'close', force: true });
  const childOnly = await tool('project_file', { action: 'import', path: path.join(models, 'child.json'), resolve_parents: false });
  if (childOnly.ok) scratch.push(childOnly.data?.project);
  await new Promise((r) => setTimeout(r, 300));
  const childCubes = await evalJs('return { cubes: Cube.all.length, dialog: !!Dialog.open }');
  check('resolve_parents false opens only the child, no dialog', childOnly.ok && childCubes?.cubes === 0 && !childCubes.dialog, JSON.stringify(childCubes));

  // ── 8. video reference controls ──────────────────────────────────────────
  console.log('\n8. video reference controls');
  let video = null;
  try {
    video = path.join(tmp, 'ref.mp4');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=10', '-pix_fmt', 'yuv420p', '-y', video]);
  } catch { video = null; }
  if (!video) {
    console.log('  SKIP  ffmpeg not available');
  } else {
    await newProject('free');
    const add = await tool('reference_images', { add: [{ path: video, name: 'clip', view_mode: 'plane', plane_position: [0, 8, -16], video: { muted: true } }] });
    await new Promise((r) => setTimeout(r, 800));
    const upd = await tool('reference_images', { update: [{ id: 'clip', video: { time: 1.2, playing: false } }] });
    const vid = upd.data?.reference_images?.find((r) => r.name === 'clip')?.video;
    check('video reference reports duration and seeks', add.ok && upd.ok && near(vid?.duration ?? 0, 2, 0.2) && near(vid?.time ?? 0, 1.2, 0.15) && vid.muted === true && vid.playing === false, JSON.stringify(vid));
    const img = path.join(tmp, 'ref.png');
    fs.writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'));
    await tool('reference_images', { add: [{ path: img, name: 'still' }] });
    const bad = await tool('reference_images', { update: [{ id: 'still', video: { playing: true } }] });
    check('video controls on an image are refused', !bad.ok && /not a video/.test(bad.text), bad.text.slice(0, 160));
  }

  // ── cleanup ──────────────────────────────────────────────────────────────
  for (const uuid of scratch.reverse()) {
    if (!uuid) continue;
    const sel = await tool('project_file', { action: 'switch_tab', uuid });
    if (sel.ok) await tool('project_file', { action: 'close', force: true });
  }
  if (originalTab) await tool('project_file', { action: 'switch_tab', uuid: originalTab });

  console.log(`\n${failures.length ? 'FAILED' : 'OK'} — ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f2 of failures) console.log(`  - ${f2}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\nERROR: ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  child.kill();
}
