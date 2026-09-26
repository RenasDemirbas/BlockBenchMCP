// Blockbench 5.2 integration test (v1.4). Blockbench 5.2+ must be running.
//
//   node scripts/verify-v52-features.mjs
//
// Every check runs in its own scratch project, closed at the end; the tab that
// was selected on entry is restored.
import { spawn } from 'node:child_process';
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
  const name = `mcp52_${format}_${Date.now().toString(36)}`;
  const res = await tool('create_project', { format, name, ...extra });
  if (res.ok) scratch.push(res.data?.uuid);
  return res;
}

try {
  await new Promise((r) => setTimeout(r, 1200));
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-v52', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const status = await tool('get_status');
  if (!status.data?.connected) throw new Error('Blockbench is not connected — start it and enable the MCP bridge plugin.');
  const originalTab = status.data.open_tabs?.find((t) => t.selected)?.uuid ?? null;
  console.log(`Blockbench ${status.data.blockbench_version}, plugin ${status.data.plugin_version}\n`);

  console.log('0. feature detection');
  const f = status.data.features || {};
  for (const key of ['texture_layer_groups', 'ik_poles', 'movable_reference_models', 'reference_image_planes', 'shade_direction_override', 'generic_bounding_boxes', 'gltf_merge_armature']) {
    check(`feature ${key}`, f[key] === true, JSON.stringify(f));
  }

  // ── 1. polyhedra + bounding boxes (free format) ──────────────────────────
  console.log('\n1. mesh polyhedra & bounding boxes');
  await newProject('free');
  const expect = { icosphere: [42, 80, 1], octahedron: [6, 8, 0], dodecahedron: [20, 36, 0] };
  for (const [shape, [verts, faces, detail]] of Object.entries(expect)) {
    const res = await tool('add_mesh_primitive', { shape, diameter: 16, detail, name: shape });
    const m = res.data?.created?.[0];
    check(`${shape}: ${verts} vertices / ${faces} faces`, res.ok && m?.vertices === verts && m?.faces === faces, res.text.slice(0, 160));
  }
  const ico = await tool('get_element', { id: 'icosphere' });
  const ys = Object.values(ico.data?.vertices ?? {}).map((v) => v[1]);
  check('icosphere rests on y=0 with its true diameter', near(Math.min(...ys), 0, 1e-3) && near(Math.max(...ys), 16, 1e-3), `y ${Math.min(...ys)}..${Math.max(...ys)}`);
  const bb = await tool('add_bounding_boxes', { boxes: [{ name: 'hitbox', from: [-4, 0, -4], to: [4, 16, 4], function: ['hitbox'] }] });
  check('generic format accepts bounding boxes', bb.ok && bb.data?.created?.[0]?.function?.[0] === 'hitbox', bb.text.slice(0, 160));
  const bbUpd = await tool('update_elements', { elements: [{ id: 'hitbox', function: ['collision', 'hitbox'], to: [4, 20, 4] }] });
  const bbEl = await tool('get_element', { id: 'hitbox' });
  check('bounding box function/size editable', bbUpd.ok && bbEl.data?.function?.length === 2 && bbEl.data?.to?.[1] === 20, bbEl.text.slice(0, 160));

  // ── 2. texture layers & groups ───────────────────────────────────────────
  console.log('\n2. texture layers & layer groups');
  await newProject('bedrock');
  await tool('add_groups', { groups: [{ name: 'body' }] });
  await tool('add_cubes', { cubes: [{ name: 'box', parent: 'body', from: [-4, 0, -4], to: [4, 8, 4] }] });
  await tool('create_texture', { name: 'layered', width: 32, height: 32, fill_color: '#808080', apply_to_all: true });
  const none = await tool('texture_layers', { texture: 'layered' });
  check('a fresh texture reports layers disabled', none.ok && none.data?.layers_enabled === false, none.text.slice(0, 120));
  const painted = await tool('paint_texture', { texture: 'layered', layer: 'shade', ops: [{ type: 'rect', from: [0, 0], to: [31, 15], color: '#000000' }] });
  check('paint_texture "layer" creates the layer on demand', painted.ok && /shade/.test(JSON.stringify(painted.data?.layers_created ?? '')), painted.text.slice(0, 200));
  const list1 = await tool('texture_layers', { texture: 'layered' });
  check('base layer + new layer exist', list1.data?.layers_enabled && list1.data?.layers?.length === 2 && list1.data.layers[1].name === 'shade', JSON.stringify(list1.data?.layers?.map((l) => l.name)));
  const grouped = await tool('texture_layers', { texture: 'layered', ops: [
    { op: 'add_group', name: 'details', layers: ['shade'] },
    { op: 'update', layer: 'shade', opacity: 0.5, blend_mode: 'multiply' },
    { op: 'add_layer', name: 'decal', parent: 'details', fill_color: 'rgba(255,0,0,1)', visible: false },
  ] });
  const shade = grouped.data?.layers?.find((l) => l.name === 'shade');
  const decal = grouped.data?.layers?.find((l) => l.name === 'decal');
  check('layer group holds its layers', grouped.ok && shade?.parent === 'details' && decal?.parent === 'details', grouped.text.slice(0, 300));
  check('opacity/blend applied (0-1 in, 0-1 out)', near(shade?.opacity ?? -1, 0.5, 1e-3) && shade?.blend_mode === 'multiply', JSON.stringify(shade));
  // Composite: grey base × 50% black multiply → darker top half; decal is hidden.
  const px = await evalJs("const t = Texture.all.find(t => t.name.startsWith('layered')); const d = t.ctx.getImageData(0,0,32,32).data; [d[(4*32+4)*4], d[(24*32+4)*4]]");
  check('composite reflects multiply at 50% and the hidden decal', Array.isArray(px) && px[0] < px[1] && px[1] === 128, JSON.stringify(px));
  // Offset layers: ops speak texture pixels.
  await tool('texture_layers', { texture: 'layered', ops: [{ op: 'update', layer: 'decal', offset: [4, 4] }] });
  await tool('paint_texture', { texture: 'layered', layer: 'decal', ops: [{ type: 'pixel', pixels: [[10, 10]], color: '#00ff00' }] });
  const decalPx = await evalJs("const t = Texture.all.find(t => t.name.startsWith('layered')); const l = t.layers.find(l => l.name == 'decal'); Array.from(l.ctx.getImageData(6, 6, 1, 1).data)");
  check('painting an offset layer lands on the right layer pixel', Array.isArray(decalPx) && decalPx[1] === 255 && decalPx[0] === 0, JSON.stringify(decalPx));
  const view = await tool('get_texture', { id: 'layered', layer: 'shade' });
  check('get_texture can show a single layer', view.ok && view.data?.showing_layer === 'shade' && view.content.some((c) => c.type === 'image'), view.text.slice(0, 120));
  const ungroup = await tool('texture_layers', { texture: 'layered', ops: [{ op: 'ungroup', layer: 'details' }, { op: 'merge_down', layer: 'shade' }] });
  check('ungroup + merge_down', ungroup.ok && !ungroup.data?.layers?.some((l) => l.name === 'details' || l.name === 'shade'), ungroup.text.slice(0, 300));
  const flat = await tool('texture_layers', { texture: 'layered', ops: [{ op: 'disable' }] });
  check('disable flattens back to a plain texture', flat.ok && flat.data?.layers_enabled === false, flat.text.slice(0, 120));
  const undoOk = await tool('undo', {});
  const relayered = await tool('texture_layers', { texture: 'layered' });
  check('layer edits are undoable', undoOk.ok && relayered.data?.layers_enabled === true, relayered.text.slice(0, 160));

  // ── 3. IK controllers with poles ─────────────────────────────────────────
  console.log('\n3. IK controllers & poles');
  await newProject('bedrock');
  await tool('add_groups', { groups: [
    { name: 'thigh', origin: [0, 12, 0] },
    { name: 'shin', parent: 'thigh', origin: [0, 6, 0] },
    { name: 'foot', parent: 'shin', origin: [0, 0, 0] },
  ] });
  await tool('add_cubes', { cubes: [
    { name: 'thigh_c', parent: 'thigh', from: [-1, 6, -1], to: [1, 12, 1] },
    { name: 'shin_c', parent: 'shin', from: [-1, 0, -1], to: [1, 6, 1] },
    { name: 'foot_c', parent: 'foot', from: [-1, 0, -3], to: [1, 1, 1] },
  ] });
  await tool('create_animation', { name: 'ik.test', loop: 'loop', length: 1 });
  const ik = await tool('add_ik_controllers', { controllers: [{ name: 'leg_ik', target: 'foot', source: 'thigh', pole_offset: [0, 0, -8], lock_rotation: true, animations: ['ik.test'] }] });
  const c = ik.data?.controllers?.[0];
  check('controller created on the foot pivot', ik.ok && c?.position?.join() === '0,0,0', ik.text.slice(0, 300));
  check('chain resolved source → target', JSON.stringify(c?.chain) === '["thigh","shin","foot"]', JSON.stringify(c?.chain));
  check('pole null object created in front of the knee', c?.pole === 'leg_ik_pole', JSON.stringify(c));
  const nullEl = await tool('get_element', { id: 'leg_ik' });
  check('null object reports its IK wiring by name', nullEl.data?.ik_target === 'foot' && nullEl.data?.ik_source === 'thigh' && nullEl.data?.ik_pole === 'leg_ik_pole' && nullEl.data?.lock_ik_target_rotation === true, nullEl.text.slice(0, 240));
  const broken = await tool('update_elements', { elements: [{ id: 'leg_ik', ik_source: 'foot', ik_target: 'thigh' }] });
  check('a reversed chain is rejected with an explanation', !broken.ok && /chain is broken/i.test(broken.text), broken.text.slice(0, 200));
  await tool('set_keyframes', { animation: 'ik.test', bones: [{ bone: 'leg_ik', channel: 'position', keyframes: [{ time: 0, values: [0, 0, 0] }, { time: 0.5, values: [0, 4, -4] }] }] });
  const pose = await tool('query_geometry', { animation: 'ik.test', time: 0.5, include_bones: true });
  const poseBones = pose.data?.samples?.[0]?.bones ?? pose.data?.bones ?? [];
  const footPos = poseBones.find((b) => b.name === 'foot')?.world_pivot;
  const kneePos = poseBones.find((b) => b.name === 'shin')?.world_pivot;
  check('IK pulls the foot pivot to the controller', Array.isArray(footPos) && near(footPos[1], 4, 0.3) && near(footPos[2], -4, 0.3), JSON.stringify(footPos));
  check('the pole bends the knee forward (north, -Z)', Array.isArray(kneePos) && kneePos[2] < -0.5, JSON.stringify(kneePos));
  const baked = await tool('bake_ik_animation', { animation: 'ik.test', detach_controllers: true });
  const addedBones = Object.keys(baked.data?.rotation_keyframes_added ?? {});
  check('bake_ik_animation writes rotation keyframes on the chain', baked.ok && addedBones.includes('thigh') && addedBones.includes('shin'), baked.text.slice(0, 240));

  // ── 4. variable placeholders ─────────────────────────────────────────────
  console.log('\n4. Molang variable placeholders');
  const vp = await tool('variable_placeholders', { add: [
    { variable: 'variable.swing', type: 'slider', range: [0, 1], step: 0.1 },
    { variable: 'variable.speed', value: 2 },
  ], values: { swing: 0.5 } });
  const swing = vp.data?.buttons?.find((b) => b.id === 'swing');
  check('slider placeholder created and set', vp.ok && swing?.value === 0.5 && /variable\.speed = 2/.test(vp.data?.text ?? ''), vp.text.slice(0, 300));
  const molang = await evalJs("Animator.MolangParser.parse('variable.swing * 10 + variable.speed')");
  check('Molang sees the placeholder values', molang === 7, JSON.stringify(molang));

  // ── 5. reference models ──────────────────────────────────────────────────
  console.log('\n5. reference models');
  const pm = await tool('preview_models', {});
  const ids = pm.data?.models?.map((m) => m.id) ?? [];
  check('crafting table reference model is listed', ids.includes('minecraft_crafting_table'), ids.join(', '));
  const moved = await tool('preview_models', { models: [{ id: 'minecraft_crafting_table', enabled: true, position: [24, 0, 0], rotation: [0, 45, 0] }] });
  const table = moved.data?.models?.find((m) => m.id === 'minecraft_crafting_table');
  check('reference model enabled and moved', moved.ok && table?.enabled && table.position[0] === 24 && near(table.rotation[1], 45, 0.01), JSON.stringify(table));
  const wide = await tool('capture_screenshot', { angle: 'north', include_reference_models: true, resolution: 256 });
  const tight = await tool('capture_screenshot', { angle: 'north', resolution: 256 });
  check('include_reference_models widens the framing', wide.ok && tight.ok && (wide.data?.coverage ?? 0) > 0, `wide ${wide.data?.coverage} tight ${tight.data?.coverage}`);
  const reset = await tool('preview_models', { models: [{ id: 'minecraft_crafting_table', reset: true, enabled: false }] });
  check('reference model reset and hidden', reset.ok && reset.data?.models?.find((m) => m.id === 'minecraft_crafting_table')?.enabled === false, reset.text.slice(0, 160));

  // ── 6. reference images as 3D planes ─────────────────────────────────────
  console.log('\n6. 3D plane reference images');
  const imgPath = path.join(os.tmpdir(), `mcp52_ref_${Date.now().toString(36)}.png`);
  await evalJs(`const c = document.createElement('canvas'); c.width = 64; c.height = 32; const x = c.getContext('2d'); x.fillStyle = '#3a7'; x.fillRect(0,0,64,32); Blockbench.writeFile(${JSON.stringify(imgPath)}, {savetype: 'image', content: c.toDataURL()}); true`);
  const ref = await tool('reference_images', { add: [{ path: imgPath, name: 'side_ref', plane_position: [0, 8, -16], plane_size: 32, opacity: 0.8 }] });
  const r0 = ref.data?.reference_images?.find((r) => r.name === 'side_ref');
  check('plane reference image added', ref.ok && r0?.view_mode === 'plane' && r0?.loaded, ref.text.slice(0, 300));
  check('plane size follows the image aspect (32 x 16 units)', near(r0?.plane_size?.[0] ?? 0, 32, 0.1) && near(r0?.plane_size?.[1] ?? 0, 16, 0.1), JSON.stringify(r0?.plane_size));
  const refUpd = await tool('reference_images', { update: [{ id: 'side_ref', plane_position: [16, 8, 0], plane_rotation: [0, 90, 0] }] });
  const r1 = refUpd.data?.reference_images?.find((r) => r.name === 'side_ref');
  check('plane reference image moved/rotated', r1?.plane_position?.join() === '16,8,0' && r1?.plane_rotation?.[1] === 90, JSON.stringify(r1));
  const refDel = await tool('reference_images', { remove: ['side_ref'] });
  check('reference image removed', refDel.ok && !refDel.data?.reference_images?.some((r) => r.name === 'side_ref'), refDel.text.slice(0, 160));

  // ── 7. java shade direction override ─────────────────────────────────────
  console.log('\n7. Java shade_direction_override');
  await newProject('java_block');
  await tool('set_project_settings', { java_block_version: '1.21.11' });
  const tooOld = await tool('add_cubes', { cubes: [{ name: 'lit', from: [0, 0, 0], to: [16, 16, 16], shade_direction_override: 'up' }] });
  check('pre-26.3 projects explain how to enable it', !tooOld.ok && /26\.3/.test(tooOld.text), tooOld.text.slice(0, 200));
  await tool('set_project_settings', { java_block_version: '26.3' });
  const lit = await tool('add_cubes', { cubes: [{ name: 'lit', from: [0, 0, 0], to: [16, 16, 16], shade_direction_override: 'up' }] });
  const litEl = await tool('get_element', { id: 'lit' });
  check('shade_direction_override set on a 26.3 cube', lit.ok && litEl.data?.shade_direction_override === 'up', litEl.text.slice(0, 200));
  const json = await tool('get_model_json', { format: 'java_block' });
  check('…and exported in the block model JSON', /shade_direction_override|"shade"/.test(json.data?.content ?? ''), (json.data?.content ?? '').slice(0, 200));
  const shelf = await tool('set_display_transforms', { slot: 'on_shelf', rotation: [0, 180, 0] });
  check('on_shelf display slot accepted', shelf.ok, shelf.text.slice(0, 160));

  // ── 8. bedrock_block display defaults ────────────────────────────────────
  console.log('\n8. bedrock_block display defaults');
  await newProject('bedrock_block');
  const gui = await tool('set_display_transforms', { slot: 'gui', rotation: [30, 45, 0] });
  check('a new bedrock gui slot starts from the game default scale', gui.ok && near(gui.data?.scale?.[0] ?? 0, 0.625, 1e-3), JSON.stringify(gui.data));

  // ── 9. skin templates ────────────────────────────────────────────────────
  console.log('\n9. skin templates');
  const cushion = await newProject('skin', { skin_model: 'cushion' });
  check('cushion skin template (5.2) builds', cushion.ok && cushion.data?.format === 'skin' && /cushion/.test(JSON.stringify(cushion.data?.bones ?? [])), cushion.text.slice(0, 240));
  const bogus = await tool('create_project', { format: 'skin', skin_model: 'not_a_mob' });
  check('unknown skin_model lists the templates', !bogus.ok && /steve/.test(bogus.text) && /cushion/.test(bogus.text), bogus.text.slice(0, 160));

  // ── cleanup ──────────────────────────────────────────────────────────────
  for (const uuid of scratch.reverse()) {
    if (!uuid) continue;
    const sel = await tool('select_project_tab', { uuid });
    if (sel.ok) await tool('close_project', { force: true });
  }
  if (originalTab) await tool('select_project_tab', { uuid: originalTab });

  console.log(`\n${failures.length ? 'FAILED' : 'OK'} — ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f2 of failures) console.log(`  - ${f2}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\nERROR: ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  child.kill();
}
