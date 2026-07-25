// E2E test for the v1.1 pro/fur toolset against a REAL running Blockbench.
// Builds a furry fox: bones + mirrored legs (mirror_elements), mirrored ear
// (add_cubes mirror), fur strips (add_planes), jagged alpha fur texture
// (paint_texture jagged_edge/noise), painted faces (paint_faces), walk cycle
// with mirror_keyframes, validation (validate_model), world queries
// (query_geometry), eval_code file/image output, offscreen screenshots.
// Outputs go to --out <dir> (default ./e2e-output/pro).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(root, 'e2e-output', 'pro');
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
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${extra ? ` — ${String(extra).slice(0, 200)}` : ''}`);
  if (!cond) failed = true;
};
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
    console.log(`FAIL ${name}: ${text.slice(0, 600)}`);
  } else {
    console.log(`PASS ${name}${text ? `: ${text.slice(0, 140).replace(/\s+/g, ' ')}` : ''}`);
  }
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { text, json, images, isError };
}

try {
  await sleep(1200);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-pro', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  let status;
  for (let attempt = 0; attempt < 8; attempt++) {
    status = await tool('get_status', {});
    if (status.json?.connected) break;
    step--;
    await sleep(2000);
  }
  if (!status.json?.connected) throw new Error('Blockbench is not connected.');
  // The pro toolset landed in 1.1 — pin the floor, not an exact build.
  const [major, minor] = String(status.json.plugin_version ?? '0.0.0').split('.').map(Number);
  check('plugin is v1.1 or newer', major > 1 || (major === 1 && minor >= 1), `plugin_version=${status.json.plugin_version}`);

  // ── project + rig ──
  await tool('create_project', { format: 'bedrock', name: 'mcp_e2e_fox', model_identifier: 'mcp_e2e_fox', texture_width: 64, texture_height: 64 });
  const info = await tool('get_project_info', {});
  check('conventions documented in project info', !!info.json?.conventions?.rotation, JSON.stringify(info.json?.conventions?.rotation).slice(0, 80));

  await tool('add_groups', {
    groups: [
      { name: 'body', origin: [0, 8, 0] },
      { name: 'head', parent: 'body', origin: [0, 11, -5] },
      { name: 'tail', parent: 'body', origin: [0, 10, 6] },
      { name: 'leg_front_left', parent: 'body', origin: [2.5, 6, -3.5] },
      { name: 'leg_back_left', parent: 'body', origin: [2.5, 6, 3.5] },
    ],
  });
  await tool('add_cubes', {
    cubes: [
      { name: 'torso', parent: 'body', from: [-3, 6, -4], to: [3, 11, 5] },
      { name: 'skull', parent: 'head', from: [-2.5, 9, -8.5], to: [2.5, 13, -4.5] },
      { name: 'snout', parent: 'head', from: [-1.5, 9.5, -11], to: [1.5, 11.5, -8.5] },
      { name: 'tail_cube', parent: 'tail', from: [-1, 8.5, 5.5], to: [1, 10.5, 11] },
      { name: 'leg_front_left_cube', parent: 'leg_front_left', from: [1.5, 0, -4.5], to: [3.5, 6, -2.5] },
      { name: 'leg_back_left_cube', parent: 'leg_back_left', from: [1.5, 0, 2.5], to: [3.5, 6, 4.5] },
    ],
  });

  // ── mirror_elements: left legs → right legs (bones + cubes + renames) ──
  const mirrored = await tool('mirror_elements', { ids: ['leg_front_left', 'leg_back_left'], duplicate: true });
  const mirroredNames = (mirrored.json?.affected || []).map((a) => a.name);
  check('mirror_elements created right-side bones', mirroredNames.includes('leg_front_right') && mirroredNames.includes('leg_back_right'), mirroredNames.join(', '));
  const rightLeg = await tool('get_element', { id: 'leg_front_right_cube' });
  check('mirrored cube geometry reflected', rightLeg.json && rightLeg.json.from[0] === -3.5 && rightLeg.json.to[0] === -1.5, JSON.stringify(rightLeg.json?.from));

  // ── add_cubes mirror: true (ear twin) ──
  const ears = await tool('add_cubes', {
    cubes: [{ name: 'ear_left', parent: 'head', from: [1, 13, -7], to: [2.5, 15, -5.5], mirror: true }],
  });
  check('add_cubes mirror created twin', ears.json?.created?.length === 2 && ears.json.created.some((c) => c.name === 'ear_right'), JSON.stringify(ears.json?.created));

  // ── fur planes: strip along the back + tail tuft ──
  const fur = await tool('add_planes', {
    strips: [{
      from: [0, 11, -3.5], to: [0, 11, 5], count: 5, height: 2.5,
      tilt: 18, alternate_tilt: true, jitter: 0.3, seed: 7,
      facing: 'east', parent: 'body', name_prefix: 'back_fur',
    }],
    planes: [
      { name: 'tail_tuft', parent: 'tail', at: [0, 10.5, 11], width: 3, height: 3, facing: 'east', rotation: [0, 0, -20] },
      { name: 'cheek_left', parent: 'head', at: [2.5, 9.5, -6.5], width: 3, height: 3, facing: 'north', rotation: [0, 0, -15] },
    ],
  });
  check('add_planes created strip + singles', fur.json?.created?.length === 7, `created=${fur.json?.created?.length}`);

  // ── texture: template → paint_faces → fur ops ──
  const tpl = await tool('generate_texture_template', { name: 'fox_tex', pixel_density: 16 });
  check('template texture has a sane size (not 16x16 fallback)', (tpl.json?.texture?.width ?? 0) >= 32, `${tpl.json?.texture?.width}x${tpl.json?.texture?.height}`);
  const pf = await tool('paint_faces', {
    targets: [
      { element: 'body', color: '#a8642e' },
      { element: 'head', color: '#b06f38' },
      { element: 'skull', faces: ['north'], color: '#d8c0a0' },
    ],
  });
  check('paint_faces painted faces', (pf.json?.painted ?? 0) > 10, `painted=${pf.json?.painted}`);

  const furPaint = await tool('paint_texture', {
    ops: [
      { type: 'jagged_edge', target: { element: 'back_fur_0', face: 'north' }, edge: 'top', depth: 4, tooth_width: 2, seed: 3 },
      { type: 'jagged_edge', target: { element: 'tail_tuft', face: 'east' }, edge: 'top', depth: 5, tooth_width: 2, seed: 5 },
      { type: 'noise', target: { element: 'torso', face: 'up' }, color: '#8a5325', color2: '#c07a3f', density: 0.3, seed: 2 },
    ],
  });
  check('fur paint ops applied', furPaint.json?.ops_applied === 3, JSON.stringify(furPaint.json));
  await tool('get_texture', { max_size: 256 });

  // ── create_texture async size fix (delete afterwards — in single-texture
  // formats a second texture would hijack the whole model) ──
  const tex = await tool('create_texture', { name: 'size_check', width: 32, height: 48, fill_color: '#336699' });
  check('create_texture reports real size immediately', tex.json?.width === 32 && tex.json?.height === 48, `${tex.json?.width}x${tex.json?.height}`);
  const del = await tool('delete_texture', { id: 'size_check' });
  check('delete_texture removed it', del.json?.deleted === 'size_check.png' || del.json?.deleted === 'size_check', JSON.stringify(del.json));

  // ── locators ──
  const loc = await tool('add_locators', { locators: [{ name: 'lead', parent: 'body', position: [0, 10, -5.5] }] });
  check('add_locators created', loc.json?.created?.length === 1, JSON.stringify(loc.json?.created));

  // ── animation: author left side, mirror to right with phase offset ──
  await tool('create_animation', { name: 'animation.fox.walk', loop: 'loop', snapping: 24, length: 0.5 });
  await tool('set_keyframes', {
    animation: 'animation.fox.walk',
    bones: [
      { bone: 'leg_front_left', channel: 'rotation', keyframes: [
        { time: 0, values: [-30, 0, 0] }, { time: 0.25, values: [30, 0, 0], interpolation: 'catmullrom' }, { time: 0.5, values: [-30, 0, 0] },
      ]},
      { bone: 'leg_back_left', channel: 'rotation', keyframes: [
        { time: 0, values: [30, 0, 0] }, { time: 0.25, values: [-30, 0, 0], interpolation: 'catmullrom' }, { time: 0.5, values: [30, 0, 0] },
      ]},
      { bone: 'tail', channel: 'rotation', keyframes: [{ time: 0, values: [0, 'math.sin(query.anim_time*720)*15', 0] }] },
    ],
  });
  const mk = await tool('mirror_keyframes', {
    animation: 'animation.fox.walk',
    mappings: [
      { from: 'leg_front_left', to: 'leg_front_right', phase_offset: 0.25 },
      { from: 'leg_back_left', to: 'leg_back_right', phase_offset: 0.25 },
    ],
  });
  check('mirror_keyframes copied', (mk.json?.mirrored || []).length === 2 && mk.json.mirrored.every((m) => m.keyframes >= 3), JSON.stringify(mk.json?.mirrored));
  const anim = await tool('get_animation', { id: 'animation.fox.walk' });
  const rightKfs = anim.json?.animators?.leg_front_right?.keyframes || [];
  check('mirrored bone has loop-consistent keyframes', rightKfs.length >= 3, `kfs=${rightKfs.length} times=${rightKfs.map((k) => k.time).join(',')}`);

  // ── auto-pair mode (should fail benignly or pair nothing new: targets have keyframes) ──
  await tool('mirror_keyframes', { animation: 'animation.fox.walk' }, true);

  // ── validate_model: rest + posed ──
  const v1 = await tool('validate_model', {});
  check('validate rest pose returns stats + intersections', !!v1.json?.stats && Array.isArray(v1.json?.intersections), `count=${v1.json?.intersection_count}`);
  const v2 = await tool('validate_model', { animation: 'animation.fox.walk', times: [0, 0.25], checks: false });
  check('validate posed returns per-time results', Array.isArray(v2.json?.by_time) && v2.json.by_time.length === 2, JSON.stringify(v2.json?.by_time?.map((t) => ({ t: t.time, n: t.count }))));

  // ── query_geometry: rest + posed ──
  const q1 = await tool('query_geometry', {});
  check('query_geometry rest: aabb + lowest + bones', !!q1.json?.model_aabb && !!q1.json?.lowest_point && Array.isArray(q1.json?.bones), `lowest=${JSON.stringify(q1.json?.lowest_point)}`);
  check('rest pose feet on ground (y≈0)', Math.abs((q1.json?.lowest_point?.y ?? 99)) < 0.6, `y=${q1.json?.lowest_point?.y}`);
  const q2 = await tool('query_geometry', { animation: 'animation.fox.walk', times: [0, 0.25] });
  check('query_geometry posed samples', Array.isArray(q2.json?.samples) && q2.json.samples.length === 2 && q2.json.samples[1].lowest_point, JSON.stringify(q2.json?.samples?.map((s) => s.lowest_point?.y)));

  // ── eval_code upgrades ──
  const evalFile = path.join(outDir, 'eval_result.json');
  const ef = await tool('eval_code', { code: 'Cube.all.map(c => ({name: c.name, from: c.from, to: c.to}))', result_file: evalFile, undo: false });
  check('eval_code result_file written', fs.existsSync(evalFile) && fs.statSync(evalFile).size > 200 && ef.json?.written_to === evalFile, `${fs.existsSync(evalFile) ? fs.statSync(evalFile).size : 0} bytes`);
  const ei = await tool('eval_code', { code: '(() => { const c = document.createElement("canvas"); c.width = c.height = 32; const x = c.getContext("2d"); x.fillStyle = "#f80"; x.fillRect(0,0,32,32); return c.toDataURL("image/png"); })()', undo: false });
  check('eval_code returns image content', ei.images.length === 1, `images=${ei.images.length}`);
  const et = await tool('eval_code', { code: 'new Array(4000).fill("x".repeat(20))', max_length: 5000, undo: false });
  check('eval_code truncates large results', et.json?.truncated === true && et.json?.note, `full_length=${et.json?.full_length}`);

  // ── offscreen screenshots (front should show the face; iso for beauty) ──
  await tool('capture_screenshot', { angle: 'north', resolution: 700 });
  await tool('capture_screenshot', { angle: 'isometric_right', resolution: 700 });
  await tool('capture_multi_view', { resolution: 400 });
  await tool('preview_animation', { animation: 'animation.fox.walk', time: 0.25, angle: 'isometric_right', resolution: 700 });

  // ── export + cleanup ──
  const geoPath = path.join(outDir, 'mcp_e2e_fox.geo.json');
  await tool('export_model', { format: 'bedrock_geo', path: geoPath });
  check('geo export exists', fs.existsSync(geoPath) && fs.statSync(geoPath).size > 500);
  const geo = JSON.parse(fs.readFileSync(geoPath, 'utf8'));
  const bones = geo['minecraft:geometry']?.[0]?.bones || [];
  check('geo has mirrored bones', bones.some((b) => b.name === 'leg_front_right') && bones.some((b) => b.name === 'leg_back_right'), bones.map((b) => b.name).join(','));

  await tool('undo', { steps: 1 });
  await tool('redo', { steps: 1 });
  await tool('close_project', { force: true });

  console.log(failed ? '\nPRO E2E TEST FAILED' : '\nPRO E2E TEST PASSED');
} catch (err) {
  console.error('PRO E2E ERROR:', err.message);
  failed = true;
} finally {
  child.kill();
  process.exit(failed ? 1 : 0);
}
