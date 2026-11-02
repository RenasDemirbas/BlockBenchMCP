// Verifies the smooth_mesh tool against a live Blockbench with the BlockSmooth
// plugin loaded:
//   * add / update / move / remove modifiers, face counts per context
//   * the viewport draws the smooth result while the cage stays pickable
//   * creases by angle, sharp edges, input validation
//   * exports carry the subdivision (OBJ, glTF), the .bbmodel keeps the cage,
//     and the cage is restored exactly after every export — also when the
//     project is saved while an async export is still running
//   * apply bakes the subdivision and is one undo step
//   * the "shading" action and pixel-art rendering of a smoothed mesh
//   * shared vertices in the viewport and in glTF (welded; never for skinned meshes),
//     and re-sharing when an armature bend turns smooth-by-angle edges sharp
//
// Spawns its own dist/mcp-server.js and works in a scratch project tab, so the
// user's models are never touched.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
const rpc = (method, params, timeoutMs = 180000) => {
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
const evalJs = async (code) => (await tool('eval_code', { code, undo: false })).json?.result;
const smooth = (args) => tool('smooth_mesh', args);

let originalTab = null;
let scratchOpen = false;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbmcp-blocksmooth-'));

try {
  await sleep(1200);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-blocksmooth', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const status = await tool('get_status', {});
  check('connected to Blockbench', status.json?.connected === true, status.json?.blockbench_version);
  if (status.json?.connected !== true) throw new Error('not connected');
  originalTab = status.json?.project?.uuid || null;
  const api = await evalJs('return window.BlockSmooth ? {version: BlockSmooth.version, api: BlockSmooth.api_version} : null');
  check('BlockSmooth plugin loaded (load blocksmooth.js first)', !!api, JSON.stringify(api));
  if (!api) throw new Error('BlockSmooth is not loaded');

  const scratch = await tool('create_project', { format: 'free', name: 'mcp_blocksmooth_probe' });
  scratchOpen = !scratch.isError;
  check('scratch project created', scratchOpen, scratch.text.slice(0, 80));
  await evalJs(`Undo.initEdit({outliner: true, elements: []});
    const cube = new Cube({name: 'box', from: [-8, 0, -8], to: [8, 16, 8]}).init();
    Undo.finishEdit('probe cube'); cube.select(); BarItems.convert_to_mesh.click(); return Mesh.all.length`);

  // ── modifiers
  const add = await smooth({ action: 'add', mesh: 'box', type: 'subdivision', levels: 2 });
  const m0 = add.json?.meshes?.[0];
  check('add subdivision: 6 cage faces -> 96 in viewport and export', m0?.viewport?.faces === 96 && m0?.export?.faces === 96 && m0?.mesh_shading === 'smooth', add.text.slice(0, 200));
  const view = await evalJs(`const m = Mesh.all[0]; const d = BlockSmooth.getDisplayObject(m);
    const mat = Array.isArray(m.mesh.material) ? m.mesh.material[0] : m.mesh.material;
    const hits = new THREE.Raycaster(new THREE.Vector3(0, 8, 40), new THREE.Vector3(0, 0, -1)).intersectObjects([m.mesh], false);
    return {display: !!d && d.parent === m.mesh, vertices: d && d.geometry.attributes.position.count, indices: d && d.geometry.index.count, cageHidden: mat.visible === false, cageHit: hits.length > 0}`);
  check('viewport shows the smooth result, cage hidden but still raycastable', view?.display && view?.indices === 96 * 6 && view?.cageHidden && view?.cageHit, JSON.stringify(view));
  check('viewport shares vertices (fewer than 4 per quad)', view?.vertices > 0 && view?.vertices < 96 * 4, JSON.stringify(view));

  const multi = await smooth({ action: 'describe', meshes: ['box'] });
  check('"meshes" works without "mesh"', !multi.isError && multi.json?.meshes?.length === 1, multi.text.slice(0, 120));
  const none = await smooth({ action: 'add', type: 'subdivision' });
  check('add without mesh or meshes is rejected', none.isError && /"mesh"/.test(none.text), none.text.slice(0, 120));
  const crease = await smooth({ action: 'crease', mesh: 'box', angle: 60 });
  check('crease by angle: the 12 box edges', crease.json?.edges === 12 && crease.json?.mesh?.creased_edges === 12, crease.text.slice(0, 160));
  const upd = await smooth({ action: 'update', mesh: 'box', modifier: 0, export_levels: 3 });
  check('update export_levels: export 384 faces, viewport unchanged', upd.json?.mesh?.export?.faces === 384 && upd.json?.mesh?.viewport?.faces === 96, upd.text.slice(0, 200));
  const sba = await smooth({ action: 'add', mesh: 'box', type: 'smooth_by_angle', angle: 40 });
  check('add smooth_by_angle', sba.json?.meshes?.[0]?.viewport?.shading === 'smooth below 40°', sba.text.slice(0, 160));
  const mv = await smooth({ action: 'move', mesh: 'box', modifier: 1, to: 0 });
  check('move modifier', mv.json?.mesh?.modifiers?.[0]?.type === 'smooth_by_angle', mv.text.slice(0, 160));
  const rm = await smooth({ action: 'remove', mesh: 'box', modifier: 0 });
  check('remove modifier', rm.json?.mesh?.modifiers?.length === 1, rm.text.slice(0, 160));
  const sharp = await smooth({ action: 'sharp', mesh: 'box', angle: 60 });
  check('mark sharp by angle', sharp.json?.mesh?.sharp_edges === 12, sharp.text.slice(0, 160));

  // ── validation
  const two = await smooth({ action: 'crease', mesh: 'box', angle: 30, selected: true });
  check('two edge sources are rejected', two.isError && /exactly one/.test(two.text), two.text.slice(0, 120));
  const badEdge = await smooth({ action: 'crease', mesh: 'box', edges: [['no', 'pe']] });
  check('unknown edges are rejected', badEdge.isError && /Not edges/.test(badEdge.text), badEdge.text.slice(0, 120));
  const badMod = await smooth({ action: 'update', mesh: 'box', modifier: 9, levels: 1 });
  check('unknown modifier is rejected with the list', badMod.isError && /Modifiers:/.test(badMod.text), badMod.text.slice(0, 120));
  const stray = await smooth({ action: 'remove', mesh: 'box', modifier: 0, levels: 2 });
  check('params of other actions are rejected', stray.isError, stray.text.slice(0, 120));

  // ── exports
  const cageSnap = 'const m = Mesh.all[0]; return JSON.stringify([m.vertices, Object.keys(m.faces), m.shading, Object.prototype.hasOwnProperty.call(m, "calculateNormals")])';
  const before = await evalJs(cageSnap);
  const objPath = path.join(tmp, 'box.obj');
  await tool('project_file', { action: 'export', format: 'obj', path: objPath });
  const objFaces = fs.existsSync(objPath) ? fs.readFileSync(objPath, 'utf8').split('\n').filter((l) => l.startsWith('f ')).length : -1;
  check('OBJ export has the export-level subdivision (384 faces)', objFaces === 384, objFaces);
  check('cage restored exactly after the OBJ export', (await evalJs(cageSnap)) === before);
  const bb = await tool('project_file', { action: 'get_json', format: 'bbmodel' });
  let model = null; try { model = JSON.parse(bb.json?.content); } catch {}
  const saved = model?.elements?.find?.((e) => e.name === 'box');
  check('.bbmodel keeps the cage and the modifier data', saved && Object.keys(saved.faces).length === 6 && saved.blocksmooth?.modifiers?.length === 1, bb.text.slice(0, 120));
  const during = await evalJs(`const m = Mesh.all[0];
    const pending = Codecs.gltf.compile({embed_textures: false, animations: false});
    const baked = Object.keys(m.faces).length;
    const save = Codecs.project.compile({compressed: false, backup: true, raw: true});
    const text = await pending;
    const gltf = JSON.parse(text);
    const prims = gltf.meshes[0].primitives;
    return {baked, savedFaces: Object.keys(save.elements.find(e => e.uuid === m.uuid).faces).length,
      gltfVertices: prims.reduce((s, p) => s + gltf.accessors[p.attributes.POSITION].count, 0),
      gltfIndices: prims.reduce((s, p) => s + gltf.accessors[p.indices].count, 0), after: Object.keys(m.faces).length}`);
  check('saving during an async glTF export writes the cage', during?.baked === 384 && during?.savedFaces === 6 && during?.after === 6, JSON.stringify(during));
  check('glTF holds the subdivided mesh', during?.gltfIndices === 384 * 6, JSON.stringify(during));
  check('glTF vertices are welded (fewer than 4 per quad)', during?.gltfVertices > 0 && during?.gltfVertices < 384 * 4, JSON.stringify(during));
  check('cage restored exactly after the glTF export', (await evalJs(cageSnap)) === before);

  // ── pixel art and shading
  const px = await tool('pixel_art', { action: 'render', size: 32 });
  check('pixel_art renders a smoothed mesh', !px.isError && px.json?.views?.[0]?.opaque_pixels > 0, px.text.slice(0, 160));
  const shading = await smooth({ action: 'shading', mesh: 'box', shading: 'flat' });
  check('shading action sets Blockbench mesh shading', !shading.isError && (await evalJs('return Mesh.all[0].shading')) === 'flat', shading.text.slice(0, 120));

  // ── apply
  const applied = await smooth({ action: 'apply', mesh: 'box' });
  const r = applied.json?.results?.[0];
  check('apply bakes the viewport subdivision', r?.applied && r?.faces_after === 96, applied.text.slice(0, 200));
  const afterApply = await evalJs('const m = Mesh.all[0]; return {faces: Object.keys(m.faces).length, display: !!BlockSmooth.getDisplayObject(m)}');
  check('applied mesh is plain geometry again (no display)', afterApply?.faces === 96 && afterApply?.display === false, JSON.stringify(afterApply));
  const undone = await evalJs('Undo.undo(); const m = Mesh.all[0]; return {faces: Object.keys(m.faces).length, display: !!BlockSmooth.getDisplayObject(m)}');
  check('undo restores the cage and its modifier', undone?.faces === 6 && undone?.display === true, JSON.stringify(undone));

  // ── skinned mesh: deformation, and glTF with and without the armature
  await evalJs(`Undo.initEdit({outliner: true, elements: []});
    const c = new Cube({name: 'tube', from: [-3, 0, -3], to: [3, 24, 3]}).init();
    Undo.finishEdit('probe tube'); c.select(); BarItems.convert_to_mesh.click(); return 1`);
  await tool('edit_mesh', { mesh: 'tube', steps: [{ op: 'loop_cut', select: { facing: 'north' }, cuts: 5, direction: 1 }] });
  const rig = await tool('add_armature', { bones: [
    { name: 'lower', head: [0, 0, 0], tail: [0, 12, 0] },
    { name: 'upper', head: [0, 12, 0], tail: [0, 24, 0], parent: 'lower', connected: true },
  ], meshes: ['tube'], weight_method: 'envelope', blend: 4 });
  check('tube rigged to an armature', !rig.isError, rig.text.slice(0, 120));
  await smooth({ action: 'add', mesh: 'tube', type: 'subdivision', levels: 2 });
  await smooth({ action: 'add', mesh: 'tube', type: 'smooth_by_angle', angle: 5 });
  const bendRes = await tool('eval_code', { undo: false, code: `return (async () => { const errors = []; const log = console.error; console.error = (...a) => { errors.push(String(a[0]).slice(0, 120)); log(...a); };
    try {
      const m = Mesh.all.find(x => x.name === 'tube');
      const rest = BlockSmooth.getDisplayObject(m).geometry.attributes.position.count;
      const anim = new Animation({name: 'bend', length: 1}).add(true); anim.select();
      const ba = anim.getBoneAnimator(ArmatureBone.all.find(b => b.name === 'upper'));
      ba.addKeyframe({channel: 'rotation', time: 0, data_points: [{x: 0, y: 0, z: 0}]});
      ba.addKeyframe({channel: 'rotation', time: 1, data_points: [{x: 0, y: 0, z: 80}]});
      Modes.options.animate.select(); anim.select(); Timeline.setTime(1); Animator.preview();
      const d = BlockSmooth.getDisplayObject(m); const g = d.geometry;
      const n = g.attributes.normal.array; let bad = 0;
      for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]); if (!(Math.abs(l - 1) < 1e-3)) bad++; }
      const box = new THREE.Box3().setFromBufferAttribute(g.attributes.position);
      const exportFaces = BlockSmooth.describe(m).export.faces; // before the exports: during one, meshes hold baked data
      const posed = Codecs.gltf.compile({embed_textures: false, animations: false, armature: false});
      const skinned = Codecs.gltf.compile({embed_textures: false, animations: false, armature: true});
      // Per kind of primitive: skinned (the tube, always written skinned by Blockbench) and static (the box).
      const read = async (p) => { const j = JSON.parse(await p); const prims = j.meshes.flatMap(x => x.primitives);
        const sum = (list) => ({vertices: list.reduce((s, q) => s + j.accessors[q.attributes.POSITION].count, 0),
          indices: list.reduce((s, q) => s + (q.indices !== undefined ? j.accessors[q.indices].count : 0), 0)});
        return {skinned: sum(prims.filter(q => q.attributes.WEIGHTS_0 !== undefined)), static: sum(prims.filter(q => q.attributes.WEIGHTS_0 === undefined))}; };
      const out = {rest, bent: g.attributes.position.count, badNormals: bad, minX: +box.min.x.toFixed(2),
        exportFaces, posed: await read(posed), skinned: await read(skinned),
        displayAfter: !!BlockSmooth.getDisplayObject(m)};
      Modes.options.edit.select();
      return {...out, errors};
    } finally { console.error = log; } })();` });
  const bend = bendRes.json?.result;
  if (!bend) console.log(bendRes.text.slice(0, 600));
  check('bending re-shares vertices where smooth-by-angle edges turn sharp', bend?.bent > bend?.rest && bend?.badNormals === 0 && bend?.minX < -4, JSON.stringify(bend));
  for (const [label, r] of [['posed glTF', bend?.posed], ['glTF with armature: true', bend?.skinned]]) {
    check(`${label}: the armature mesh stays skinned and unwelded (one weighted vertex per face corner)`,
      r?.skinned?.indices === bend.exportFaces * 6 && r?.skinned?.vertices === bend.exportFaces * 4, JSON.stringify(r));
    check(`${label}: the static mesh beside it is welded`, r?.static?.indices > 0 && r?.static?.vertices < r.static.indices / 6 * 4, JSON.stringify(r));
  }
  check('no errors while deforming and exporting; display back afterwards', bend?.errors?.length === 0 && bend?.displayAfter, JSON.stringify(bend?.errors));

  console.log(failed ? `\nBLOCKSMOOTH VERIFY FAILED (${passes} passed)` : `\nBLOCKSMOOTH VERIFY PASSED (${passes} checks)`);
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
  fs.rmSync(tmp, { recursive: true, force: true });
  child.kill();
  process.exit(failed ? 1 : 0);
}
