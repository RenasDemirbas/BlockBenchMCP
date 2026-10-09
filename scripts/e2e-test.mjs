// End-to-end test against a REAL running Blockbench with the MCP plugin loaded.
// Builds a small wolf-like model with bones, texture, walk animation; renders
// screenshots; exports files. Outputs go to --out <dir> (default ./e2e-output).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(root, 'e2e-output');
fs.mkdirSync(outDir, { recursive: true });

const PORT = process.env.BB_BRIDGE_PORT || '8188';
const child = spawn(process.execPath, [path.join(root, 'dist', 'mcp-server.js')], {
  env: { ...process.env, BB_BRIDGE_PORT: PORT },
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
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    } catch {}
  }
});

function rpc(method, params, timeoutMs = 150000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
let step = 0;
async function tool(name, args, expectError = false) {
  step++;
  const res = await rpc('tools/call', { name, arguments: args });
  const result = res.result;
  const text = result?.content?.find((c) => c.type === 'text')?.text || '';
  const images = (result?.content || []).filter((c) => c.type === 'image');
  images.forEach((img, i) => {
    const file = path.join(outDir, `${String(step).padStart(2, '0')}_${name}${images.length > 1 ? `_${i}` : ''}.png`);
    fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
    console.log(`   [image saved] ${file}`);
  });
  const isError = result?.isError === true;
  if (isError !== expectError) {
    failed = true;
    console.log(`FAIL ${name}: ${text.slice(0, 500)}`);
  } else {
    console.log(`PASS ${name}${text ? `: ${text.slice(0, 140).replace(/\s+/g, ' ')}` : ''}`);
  }
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { text, json, images, isError };
}

try {
  await sleep(1200);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  // 0. Status — requires real Blockbench connected (plugin reconnects every ~2.5s)
  let status;
  for (let attempt = 0; attempt < 8; attempt++) {
    status = await tool('get_status', {});
    if (status.json?.connected) break;
    step--; // don't count retries
    await sleep(2000);
  }
  if (!status.json?.connected) throw new Error('Blockbench is not connected — open Blockbench with the plugin loaded first.');

  // 1. Project
  await tool('create_project', { format: 'bedrock', name: 'mcp_e2e_wolf', model_identifier: 'mcp_e2e_wolf', texture_width: 64, texture_height: 64 });
  await tool('get_project_info', {});

  // 2. Bones
  await tool('add_groups', {
    groups: [
      { name: 'body', origin: [0, 8, 0] },
      { name: 'head', parent: 'body', origin: [0, 11, -5] },
      { name: 'tail', parent: 'body', origin: [0, 10, 6] },
      { name: 'leg_fl', parent: 'body', origin: [-2.5, 6, -3.5] },
      { name: 'leg_fr', parent: 'body', origin: [2.5, 6, -3.5] },
      { name: 'leg_bl', parent: 'body', origin: [-2.5, 6, 3.5] },
      { name: 'leg_br', parent: 'body', origin: [2.5, 6, 3.5] },
    ],
  });

  // 3. Cubes
  await tool('add_cubes', {
    cubes: [
      { name: 'torso', parent: 'body', from: [-3, 6, -4], to: [3, 11, 5] },
      { name: 'skull', parent: 'head', from: [-2.5, 9, -8.5], to: [2.5, 13, -4.5] },
      { name: 'snout', parent: 'head', from: [-1.5, 9.5, -11], to: [1.5, 11.5, -8.5] },
      { name: 'ear_l', parent: 'head', from: [-2.5, 13, -7], to: [-1, 15, -5.5] },
      { name: 'ear_r', parent: 'head', from: [1, 13, -7], to: [2.5, 15, -5.5] },
      { name: 'tail_cube', parent: 'tail', from: [-1, 8.5, 5.5], to: [1, 10.5, 11] },
      { name: 'leg_fl_cube', parent: 'leg_fl', from: [-3.5, 0, -4.5], to: [-1.5, 6, -2.5] },
      { name: 'leg_fr_cube', parent: 'leg_fr', from: [1.5, 0, -4.5], to: [3.5, 6, -2.5] },
      { name: 'leg_bl_cube', parent: 'leg_bl', from: [-3.5, 0, 2.5], to: [-1.5, 6, 4.5] },
      { name: 'leg_br_cube', parent: 'leg_br', from: [1.5, 0, 2.5], to: [3.5, 6, 4.5] },
    ],
  });
  await tool('list_outline', { include_elements: true });

  // 4. Texture template + paint
  await tool('generate_texture_template', { name: 'wolf_tex', pixel_density: 16 });
  await tool('paint_texture', {
    ops: [
      { type: 'fill', at: [1, 1], color: '#8a6f52', tolerance: 100 },
      { type: 'rect', from: [0, 0], to: [63, 63], color: '#6b543c', filled: false, thickness: 1 },
      { type: 'ellipse', center: [0.35, 0.4], radius: [0.06, 0.1], color: '#1c1c1c', target: { element: 'skull', face: 'north' } },
      { type: 'ellipse', center: [0.65, 0.4], radius: [0.06, 0.1], color: '#1c1c1c', target: { element: 'skull', face: 'north' } },
      { type: 'rect', from: [0.3, 0.55], to: [0.7, 1], color: '#3a2e21', target: { element: 'snout', face: 'north' } },
    ],
  });
  await tool('get_texture', { max_size: 256 });

  // 5. Animation — walk cycle with rigged bones
  await tool('create_animation', { name: 'animation.wolf.walk', loop: 'loop', snapping: 24 });
  await tool('set_keyframes', {
    animation: 'animation.wolf.walk',
    bones: [
      { bone: 'leg_fl', channel: 'rotation', keyframes: [
        { time: 0, values: [-30, 0, 0] }, { time: 0.25, values: [30, 0, 0], interpolation: 'catmullrom' }, { time: 0.5, values: [-30, 0, 0] },
      ]},
      { bone: 'leg_br', channel: 'rotation', keyframes: [
        { time: 0, values: [-30, 0, 0] }, { time: 0.25, values: [30, 0, 0], interpolation: 'catmullrom' }, { time: 0.5, values: [-30, 0, 0] },
      ]},
      { bone: 'leg_fr', channel: 'rotation', keyframes: [
        { time: 0, values: [30, 0, 0] }, { time: 0.25, values: [-30, 0, 0], interpolation: 'catmullrom' }, { time: 0.5, values: [30, 0, 0] },
      ]},
      { bone: 'leg_bl', channel: 'rotation', keyframes: [
        { time: 0, values: [30, 0, 0] }, { time: 0.25, values: [-30, 0, 0], interpolation: 'catmullrom' }, { time: 0.5, values: [30, 0, 0] },
      ]},
      { bone: 'head', channel: 'rotation', keyframes: [
        { time: 0, values: ['math.sin(query.anim_time*720)*3', 0, 0] },
      ]},
      { bone: 'tail', channel: 'rotation', keyframes: [
        { time: 0, values: [0, 'math.sin(query.anim_time*720)*15', 0] },
      ]},
      { bone: 'body', channel: 'position', keyframes: [
        { time: 0, values: [0, 0, 0] }, { time: 0.25, values: [0, 0.5, 0], interpolation: 'catmullrom' }, { time: 0.5, values: [0, 0, 0] },
      ]},
    ],
  });
  const animInfo = await tool('get_animation', { id: 'animation.wolf.walk' });
  const animators = animInfo.json?.animators || {};
  const kfTotal = Object.values(animators).reduce((n, a) => n + (a.keyframes?.length || 0), 0);
  if (kfTotal < 15) { failed = true; console.log(`FAIL keyframe count: expected >=15, got ${kfTotal}`); }
  else console.log(`PASS keyframe verification (${kfTotal} keyframes)`);

  // 6. Visual feedback
  await tool('capture_multi_view', { resolution: 400 });
  await tool('preview_animation', { animation: 'animation.wolf.walk', time: 0.25, angle: 'isometric_right', resolution: 700 });
  await tool('render_animation', { animation: 'animation.wolf.walk', frames: 4, resolution: 360 });

  // 7. Export everything
  const geoPath = path.join(outDir, 'mcp_e2e_wolf.geo.json');
  const animPath = path.join(outDir, 'mcp_e2e_wolf.animation.json');
  const bbPath = path.join(outDir, 'mcp_e2e_wolf.bbmodel');
  const gltfPath = path.join(outDir, 'mcp_e2e_wolf.gltf');
  await tool('project_file', { action: 'export', format: 'bedrock_geo', path: geoPath });
  await tool('project_file', { action: 'export_animations', path: animPath });
  await tool('project_file', { action: 'save', path: bbPath });
  await tool('project_file', { action: 'export', format: 'gltf', path: gltfPath, options: { animations: true } });

  for (const [label, file] of [['geo', geoPath], ['anim', animPath], ['bbmodel', bbPath], ['gltf', gltfPath]]) {
    const ok = fs.existsSync(file) && fs.statSync(file).size > 100;
    console.log(`${ok ? 'PASS' : 'FAIL'} export file (${label}): ${file} ${ok ? `${fs.statSync(file).size} bytes` : 'MISSING'}`);
    if (!ok) failed = true;
  }
  const geo = JSON.parse(fs.readFileSync(geoPath, 'utf8'));
  const bones = geo['minecraft:geometry']?.[0]?.bones || [];
  console.log(`${bones.length >= 7 ? 'PASS' : 'FAIL'} geo bones: ${bones.map((b) => b.name).join(', ')}`);
  const animJson = JSON.parse(fs.readFileSync(animPath, 'utf8'));
  const animBones = Object.keys(animJson.animations?.['animation.wolf.walk']?.bones || {});
  console.log(`${animBones.length >= 6 ? 'PASS' : 'FAIL'} animation bones: ${animBones.join(', ')}`);

  // 8. Undo works
  await tool('undo', { steps: 1 });
  await tool('redo', { steps: 1 });

  console.log(failed ? '\nE2E TEST FAILED' : '\nE2E TEST PASSED');
} catch (err) {
  console.error('E2E ERROR:', err.message);
  failed = true;
} finally {
  child.kill();
  process.exit(failed ? 1 : 0);
}
