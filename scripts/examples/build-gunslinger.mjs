// Builds the four-armed gas-mask gunslinger from a reference picture with the
// low-poly tools (add_loft, edit_mesh, transform_mesh, unwrap_mesh, bake_texture),
// recording the build as a GIF. Usage: OUT=<abs folder> node scripts/examples/build-gunslinger.mjs
// scratch project tab so the user's model is never touched.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
const OUT = process.env.OUT;
const STAGE = process.env.STAGE || 'all';
async function T(name, args) {
  const r = await tool(name, args);
  if (r.isError) { console.log(`ERR ${name}: ${r.text.slice(0, 300)}`); throw new Error(name); }
  console.log(`ok  ${name} ${args.name || args.action || ''}`);
  return r;
}
const loft = (name, parent, rings, extra = {}) => T('add_loft', { name, parent, rings, ...extra });
const box = (name, parent, from, to, rotation, origin) => T('add_cubes', { cubes: [{ name, parent, from, to, ...(rotation ? { rotation, origin } : {}) }] });

try {
  await sleep(1200);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cowboy', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  if (STAGE === 'all' || STAGE === 'model') {
  await T('create_project', { format: 'free', name: 'gunslinger' });
  await T('record_build', { action: 'start', view: 'front', yaw: 15, size: 320, height_units: 70, background: '#ffffff' });

  await T('add_groups', { groups: [
    { name: 'body', origin: [0, 34, 0] },
    { name: 'legs', parent: 'body', origin: [0, 26, 0] },
    { name: 'head', parent: 'body', origin: [0, 51, 0] },
    { name: 'g_arm_up_l', parent: 'body', origin: [8.5, 47, 0] },
    { name: 'g_arm_up_r', parent: 'body', origin: [-8.5, 47, 0] },
    { name: 'g_arm_lo_l', parent: 'body', origin: [6.5, 44, 0] },
    { name: 'g_arm_lo_r', parent: 'body', origin: [-6.5, 44, 0] },
  ] });

  // legs: pointed pegs, baggy trousers, jeans thighs
  await loft('peg_l', 'legs', [{ at: [5.6, 0, -0.5], size: 0.6 }, { at: [5, 3, -0.3], size: [2, 2.2] }, { at: [3.8, 10, 0], size: [2.8, 2.8] }]);
  await loft('peg_r', 'legs', [{ at: [-8.2, 0, -0.5], size: 0.6 }, { at: [-7.4, 3, -0.3], size: [2, 2.2] }, { at: [-5.6, 10, 0], size: [2.8, 2.8] }]);
  await loft('trouser_l', 'legs', [{ at: [3.8, 9, 0], size: [4.4, 4.4] }, { at: [4.8, 12, 0], size: [8, 7.4] }, { at: [5.6, 19, 0], size: [10.4, 8.8] }, { at: [4.2, 26, 0], size: [8, 7] }], { sides: 8, profile: 'round' });
  await loft('trouser_r', 'legs', [{ at: [-5.6, 9, 0], size: [4.4, 4.4] }, { at: [-6.8, 12, 0], size: [8, 7.4] }, { at: [-7.6, 19, 0], size: [10.4, 8.8] }, { at: [-5, 26, 0], size: [8, 7] }], { sides: 8, profile: 'round' });
  await loft('jeans_l', 'legs', [{ at: [4, 24.5, 0], size: [8, 6.4] }, { at: [3.6, 31, 0], size: [7.2, 6] }, { at: [3, 35.5, 0], size: [6.2, 5.6] }]);
  await loft('jeans_r', 'legs', [{ at: [-4.8, 24.5, 0], size: [8, 6.4] }, { at: [-4, 31, 0], size: [7.2, 6] }, { at: [-3, 35.5, 0], size: [6.2, 5.6] }]);
  await loft('belt', 'body', [{ at: [0, 35, 0], size: [12.4, 6.4] }, { at: [0, 36.6, 0], size: [12.2, 6.3] }]);
  await box('buckle', 'body', [-1, 35.1, -3.5], [1, 36.5, -3.1]);

  // torso, collar, capelet, back cape
  await loft('vest', 'body', [{ at: [0, 36, 0], size: [10.4, 6] }, { at: [0, 42, 0], size: [11, 6.4] }, { at: [0, 48, 0], size: [11.6, 6.8] }]);
  await loft('back_cape', 'body', [{ at: [0, 48, 3.8], size: [15, 1] }, { at: [0, 42, 4.8], size: [18, 1] }, { at: [0, 36, 5.6], size: [19, 1] }]);
  await loft('capelet', 'body', [{ at: [0, 51.5, 0], size: [9, 7] }, { at: [0, 49, 0], size: [17, 12] }, { at: [0, 47.3, 0], size: [21, 14] }], { profile: 'round', sides: 10 });
  await loft('fur_trim', 'body', [{ at: [0, 48, 0], size: [21.4, 14.4] }, { at: [0, 47, 0], size: [22.4, 15.2] }, { at: [0, 46.2, 0], size: [21.6, 14.6] }], { profile: 'round', sides: 10 });
  await loft('collar', 'head', [{ at: [0, 50.5, 0], size: [6.4, 5.6] }, { at: [0, 53.5, 0], size: [5.6, 5] }], { profile: 'round', sides: 8 });

  // head + gas mask
  await loft('skull', 'head', [{ at: [0, 52.5, 0.4], size: [4.6, 4.6] }, { at: [0, 57.6, 0.4], size: [5, 5] }]);
  await box('goggle_l', 'head', [0.5, 55, -2.6], [2.2, 56.4, -1.8]);
  await box('goggle_r', 'head', [-2.2, 55, -2.6], [-0.5, 56.4, -1.8]);
  await box('respirator', 'head', [-1.1, 52.4, -3.4], [1.1, 54.8, -1.8]);
  await loft('canister_l', 'head', [{ at: [0.8, 53.4, -2.8], size: 1.3 }, { at: [3.6, 52.6, -3.4], size: 1.5 }], { profile: 'round', sides: 6 });
  await loft('canister_r', 'head', [{ at: [-0.8, 53.4, -2.8], size: 1.3 }, { at: [-3.6, 52.6, -3.4], size: 1.5 }], { profile: 'round', sides: 6 });

  // hat
  await T('add_mesh_primitive', { shape: 'cylinder', sides: 12, diameter: 21, height: 0.8, name: 'hat_brim', parent: 'head', position: [0, 57.4, 0.4], rotation: [-6, 0, 7] });
  await loft('hat_crown', 'head', [{ at: [0.3, 58, 0.4], size: [9, 8.6] }, { at: [0.5, 61.6, 0.6], size: [8, 7.6] }, { at: [0.6, 62.6, 0.6], size: [6.4, 6] }], { profile: 'round', sides: 10 });

  // four arms
  await loft('arm_up_l', 'g_arm_up_l', [{ at: [8.4, 47.5, 0], size: 4 }, { at: [11.2, 51, -0.8], size: 3.6 }, { at: [12, 53.6, -1.8], size: 3.2 }, { at: [8.4, 58, -3.8], size: 2.8 }, { at: [5.6, 59.8, -4.8], size: 2.6 }]);
  await box('hand_up_l', 'g_arm_up_l', [3.4, 58.8, -6.4], [6.2, 61.6, -3.8], [10, 0, 20], [4.8, 60.2, -5]);
  await loft('arm_up_r', 'g_arm_up_r', [{ at: [-8.4, 47.5, 0], size: 4 }, { at: [-10, 43.5, 0.2], size: 3.6 }, { at: [-10.2, 39.8, -0.6], size: 3.2 }, { at: [-12.8, 40.4, -2.6], size: 2.8 }, { at: [-14, 40.9, -3.4], size: 2.6 }]);
  await box('hand_up_r', 'g_arm_up_r', [-16, 39.2, -5], [-13.2, 42.4, -2.2]);
  await loft('arm_lo_l', 'g_arm_lo_l', [{ at: [6, 44, 0.5], size: 3.2 }, { at: [9.4, 38.5, 0.3], size: 3 }, { at: [10.4, 34.4, -0.8], size: 2.8 }, { at: [10.8, 31.6, -1.8], size: 2.5 }]);
  await box('hand_lo_l', 'g_arm_lo_l', [9.6, 29, -3.2], [12.4, 31.8, -0.6]);
  await loft('arm_lo_r', 'g_arm_lo_r', [{ at: [-6, 44, 0.5], size: 3.2 }, { at: [-9, 38.5, 0.3], size: 3 }, { at: [-10, 34.4, -0.4], size: 2.8 }, { at: [-10.4, 32.4, -0.8], size: 2.5 }]);
  await box('hand_lo_r', 'g_arm_lo_r', [-11.8, 30, -2.2], [-9, 32.8, 0.4]);

  // guns
  await loft('gun_up_barrel', 'g_arm_up_r', [{ at: [-14.8, 42, -3.6], size: [1.4, 1.8] }, { at: [-17.6, 57, -3.6], size: [1.2, 1.6] }]);
  await loft('gun_up_body', 'g_arm_up_r', [{ at: [-14.6, 40.6, -3.6], size: [2.2, 2.6] }, { at: [-15.4, 45, -3.6], size: [2.2, 2.6] }]);
  await loft('gun_lo_barrel', 'g_arm_lo_l', [{ at: [11.6, 30.4, -2], size: [1.4, 1.8] }, { at: [20.5, 22.5, -3], size: [1.2, 1.6] }]);
  await loft('gun_lo_body', 'g_arm_lo_l', [{ at: [11, 31, -2], size: [2.4, 2.6] }, { at: [14, 28.4, -2.2], size: [2.4, 2.6] }]);
  await loft('holster_gun', 'legs', [{ at: [-10.6, 31, -0.6], size: [2, 2.4] }, { at: [-11.4, 24, -1], size: [2, 2.4] }, { at: [-11.8, 18.5, -1], size: [3, 3.2] }]);
  await box('holster_drum', 'legs', [-13.6, 17, -2.8], [-10, 20, 0.8]);

  // shaping
  await T('transform_mesh', { meshes: ['trouser_l', 'trouser_r'], ops: [{ type: 'jitter', amount: 0.35, seed: 4 }] });
  await T('transform_mesh', { meshes: ['arm_up_l', 'arm_up_r', 'arm_lo_l', 'arm_lo_r'], ops: [{ type: 'jitter', amount: 0.25, seed: 9 }] });
  await T('edit_mesh', { mesh: 'gun_lo_body', steps: [{ op: 'bevel', amount: 0.3 }] });
  await T('edit_mesh', { mesh: 'gun_up_body', steps: [{ op: 'bevel', amount: 0.3 }] });
  }

  if (STAGE === 'all' || STAGE === 'paint') {
  await T('unwrap_mesh', { pixel_density: 48, density_scale: { head: 1.6 }, name: 'gunslinger_tex', keep_paint: false });
  const SKIN = '#6e2a2a', HAT = '#5e2219', VEST = '#26304c', JEANS = '#4c5c8c', TROUS = '#561c18', GUN = '#a9b0d0', CAPE = '#3a1a22', FUR = '#efe2c4', MASK = '#b9bdd0', BELT = '#7a3a20';
  await T('paint_faces', { targets: [
    ...['peg_l', 'peg_r', 'arm_up_l', 'arm_up_r', 'arm_lo_l', 'arm_lo_r', 'hand_up_l', 'hand_up_r', 'hand_lo_l', 'hand_lo_r', 'collar', 'skull'].map((element) => ({ element, color: SKIN })),
    { element: 'trouser_l', color: TROUS }, { element: 'trouser_r', color: TROUS },
    { element: 'jeans_l', color: JEANS }, { element: 'jeans_r', color: JEANS },
    { element: 'belt', color: BELT }, { element: 'buckle', color: '#c8ccd8' },
    { element: 'vest', color: VEST }, { element: 'back_cape', color: CAPE }, { element: 'capelet', color: HAT }, { element: 'fur_trim', color: FUR },
    { element: 'hat_brim', color: HAT }, { element: 'hat_crown', color: HAT },
    { element: 'goggle_l', color: '#ffd84a' }, { element: 'goggle_r', color: '#ffd84a' },
    { element: 'respirator', color: MASK }, { element: 'canister_l', color: MASK }, { element: 'canister_r', color: MASK },
    ...['gun_up_barrel', 'gun_up_body', 'gun_lo_barrel', 'gun_lo_body', 'holster_gun', 'holster_drum'].map((element) => ({ element, color: GUN })),
  ] });
  const buttons = [0.2, 0.5, 0.8].map((y) => ({ type: 'ellipse', target: { element: 'vest', faces: ['north'] }, center: [0.5, y], radius: [1.2, 1.2], color: '#e8a83a' }));
  await T('paint_texture', { ops: [
    ...buttons,
    { type: 'strands', target: { element: 'trouser_l', faces: 'all' }, direction: 'down', density: 0.025, length: [0.1, 0.3], color: '#8a3424', color2: '#c0582e', light_ratio: 0.4, seed: 2 },
    { type: 'strands', target: { element: 'trouser_r', faces: 'all' }, direction: 'down', density: 0.025, length: [0.1, 0.3], color: '#8a3424', color2: '#c0582e', light_ratio: 0.4, seed: 5 },
    { type: 'rect', target: { element: 'jeans_l', faces: ['north'] }, from: [0, 0], to: [0.22, 1], color: '#c9d2ec' },
    { type: 'rect', target: { element: 'jeans_l', faces: ['east'] }, from: [0, 0], to: [0.3, 1], color: '#c9d2ec' },
    { type: 'jagged_edge', target: { element: 'fur_trim', faces: 'all' }, edge: 'bottom', mode: 'color', depth: 2, tooth_width: 2, color: '#fff6e0' },
    { type: 'noise', target: { element: 'fur_trim', faces: 'all' }, density: 0.25, color: '#d8c6a0', seed: 13 },
    { type: 'rect', target: { element: 'jeans_r', faces: ['north'] }, from: [0.78, 0], to: [1, 1], color: '#c9d2ec' },
    { type: 'rect', target: { element: 'jeans_r', faces: ['west'] }, from: [0.7, 0], to: [1, 1], color: '#c9d2ec' },
    { type: 'noise', target: { element: 'jeans_l', faces: 'all' }, density: 0.12, color: '#6474a4', seed: 3 },
    { type: 'noise', target: { element: 'jeans_r', faces: 'all' }, density: 0.12, color: '#6474a4', seed: 6 },
    { type: 'line', target: { element: 'respirator', faces: ['north'] }, from: [0.5, 0.1], to: [0.5, 0.9], color: '#7a7f94' },
    { type: 'noise', target: { element: 'capelet', faces: 'all' }, density: 0.1, color: '#8a3a28', seed: 8 },
    { type: 'noise', target: { element: 'hat_brim', faces: 'all' }, density: 0.1, color: '#8a3a28', seed: 9 },
    { type: 'strands', target: { element: 'arm_up_l', faces: 'all' }, direction: 'down', density: 0.05, length: [0.1, 0.3], color: '#8e3c34', color2: '#a65042', seed: 11 },
    { type: 'strands', target: { element: 'arm_up_r', faces: 'all' }, direction: 'down', density: 0.05, length: [0.1, 0.3], color: '#8e3c34', color2: '#a65042', seed: 12 },
  ] });
  await T('bake_texture', { layer: 'shading', passes: [
    { type: 'light', direction: [0.4, 1, -0.8], shadow: 1.5, highlight: 1 },
    { type: 'ao', distance: 5, strength: 1.5 },
    { type: 'edges', highlight: 1, cavity: 1, boundary: 1 },
    { type: 'noise', amount: 0.25, seed: 4 },
  ] });
  await T('paint_faces', { layer: 'shading', targets: [{ element: 'goggle_l', faces: ['north'], color: '#fff2a0' }, { element: 'goggle_r', faces: ['north'], color: '#fff2a0' }] });
  }

  if (STAGE === 'all') {
    await T('project_file', { action: 'save', path: `${OUT}/gunslinger.bbmodel` });
    const stop = await T('record_build', { action: 'stop', path: `${OUT}/gunslinger_build.gif`, fps: 5, hold_last: 3 });
    console.log(stop.json?.frames, 'frames');
  }
} catch (err) {
  console.log('FAILED', err.message);
} finally {
  child.kill();
  process.exit(0);
}
