// Pixel-art export verification (v1.5). Blockbench must be running with the
// MCP bridge plugin loaded.
//
//   node scripts/verify-pixel-art.mjs
//
// Builds its own asymmetric scratch model (red nose to the NORTH, a long green
// arm on the EAST side, a short magenta arm on the WEST), renders it through
// render_pixel_art / export_pixel_sprites, decodes the PNGs it wrote and checks
// the things that make output real pixel art: binary alpha, exact texel
// colours in flat mode, palette membership, pivot placement, direction
// naming, sheet geometry and Aseprite JSON. Outputs land in e2e-output/pixelart.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'e2e-output', 'pixelart');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

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
const rpc = (method, params, timeoutMs = 300000) => {
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

let passed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ───────────────────────────── minimal PNG decoder ─────────────────────────────
function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  let pos = 8, width = 0, height = 0, colorType = 0, bitDepth = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) throw new Error(`${file}: unsupported PNG (depth ${bitDepth}, type ${colorType}, interlace ${interlace})`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = line[x * bpp]; out[(y * width + x) * 4 + 1] = line[x * bpp + 1]; out[(y * width + x) * 4 + 2] = line[x * bpp + 2];
      out[(y * width + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}
const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
function analyse(img) {
  const colors = new Map();
  let opaque = 0, semi = 0, minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const a = img.data[i + 3];
      if (a === 0) continue;
      if (a !== 255) semi++;
      opaque++;
      const h = hex(img.data[i], img.data[i + 1], img.data[i + 2]);
      colors.set(h, (colors.get(h) || 0) + 1);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  return { colors, opaque, semi, bounds: { minX, maxX, minY, maxY } };
}
function pixelsOf(img, predicate) {
  const pts = [];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3] && predicate(img.data[i], img.data[i + 1], img.data[i + 2])) pts.push([x, y]);
  }
  return pts;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
// Tight enough that a deep-shadow skin tone (#a04a20-ish) does not count as red.
const isRed = (r, g, b) => r > 150 && g < 90 && b < 110 && r - g > 110;
const isGreen = (r, g, b) => g > 120 && r < 90 && b < 90;
const isMagenta = (r, g, b) => r > 120 && b > 120 && g < 90;

const scratch = [];
try {
  await new Promise((r) => setTimeout(r, 1200));
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-pixel-art', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const status = await tool('get_status');
  if (!status.data?.connected) throw new Error('Blockbench is not connected — start it and enable the MCP bridge plugin.');
  const originalTab = status.data.open_tabs?.find((t) => t.selected)?.uuid ?? null;
  console.log(`Blockbench ${status.data.blockbench_version}, plugin ${status.data.plugin_version}\n`);

  console.log('0. presets');
  const presets = await tool('pixel_art', { action: 'presets' });
  check('pixel_art_presets lists views, styles and palettes', presets.ok && presets.data?.views?.side && presets.data?.palettes?.pico8 && presets.data?.styles?.outlined, presets.text.slice(0, 200));

  // ── scratch model ─────────────────────────────────────────────────────────
  console.log('\n1. scratch model');
  const proj = await tool('create_project', { format: 'bedrock', name: `mcp_pixelart_${Date.now().toString(36)}` });
  if (!proj.ok) throw new Error(`create_project failed: ${proj.text}`);
  scratch.push(proj.data?.uuid);
  await tool('add_groups', { groups: [
    { name: 'root', origin: [0, 0, 0] },
    { name: 'body', parent: 'root', origin: [0, 6, 0] },
    { name: 'head', parent: 'body', origin: [0, 14, 0] },
    { name: 'right_arm', parent: 'body', origin: [5, 14, 0] },
    { name: 'left_arm', parent: 'body', origin: [-5, 14, 0] },
    { name: 'right_leg', parent: 'root', origin: [2, 6, 0] },
    { name: 'left_leg', parent: 'root', origin: [-2, 6, 0] },
  ] });
  const cubes = await tool('add_cubes', { cubes: [
    { name: 'body_c', parent: 'body', from: [-4, 6, -2], to: [4, 14, 2] },
    { name: 'head_c', parent: 'head', from: [-3, 14, -3], to: [3, 20, 3] },
    { name: 'nose_c', parent: 'head', from: [-1, 15, -5], to: [1, 17, -3] },
    { name: 'right_arm_c', parent: 'right_arm', from: [4, 4, -1], to: [6, 14, 1] },
    { name: 'left_arm_c', parent: 'left_arm', from: [-6, 9, -1], to: [-4, 14, 1] },
    { name: 'right_leg_c', parent: 'right_leg', from: [1, 0, -1], to: [3, 6, 1] },
    { name: 'left_leg_c', parent: 'left_leg', from: [-3, 0, -1], to: [-1, 6, 1] },
  ] });
  check('scratch cubes created', cubes.ok && cubes.data?.created?.length === 7, cubes.text.slice(0, 200));
  const tpl = await tool('generate_texture_template', { name: 'pixelart_test', resolution: 1 });
  check('texture template generated', tpl.ok, tpl.text.slice(0, 200));
  const painted = await tool('paint_faces', { targets: [
    { element: 'body', faces: 'all', color: '#4a6fd6' },
    { element: 'head_c', faces: 'all', color: '#e0b070' },
    { element: 'nose_c', faces: 'all', color: '#d02020' },
    { element: 'right_arm', faces: 'all', color: '#20c020' },
    { element: 'left_arm', faces: 'all', color: '#c020c0' },
    { element: 'right_leg', faces: 'all', color: '#404040' },
    { element: 'left_leg', faces: 'all', color: '#404040' },
  ] });
  check('faces painted with 6 flat colours', painted.ok, painted.text.slice(0, 200));
  const SOURCE = new Set(['#4a6fd6', '#e0b070', '#d02020', '#20c020', '#c020c0', '#404040']);
  await tool('create_animation', { name: 'walk', loop: 'loop', length: 0.5 });
  await tool('set_keyframes', { animation: 'walk', bones: [
    { bone: 'right_arm', channel: 'rotation', keyframes: [{ time: 0, values: [0, 0, 0] }, { time: 0.25, values: [60, 0, 0] }, { time: 0.5, values: [0, 0, 0] }] },
    { bone: 'left_leg', channel: 'rotation', keyframes: [{ time: 0, values: [-30, 0, 0] }, { time: 0.25, values: [30, 0, 0] }, { time: 0.5, values: [-30, 0, 0] }] },
  ] });

  // ── 2. flat render: exact texel colours, binary alpha, scale, pivot ───────
  console.log('\n2. flat side view (exactness)');
  const flat = await tool('pixel_art', { action: 'render', view: 'side', size: 32, style: 'flat', palette: 'none', cleanup: 'none', directory: outDir, name: 'flat' });
  check('render_pixel_art (flat) succeeds with an image', flat.ok && flat.content.some((c) => c.type === 'image'), flat.text.slice(0, 300));
  check('auto scale snapped to 1 px per unit (texel aligned)', flat.data?.pixels_per_unit === 1 && flat.data?.texel_size_px === 1, JSON.stringify({ ppu: flat.data?.pixels_per_unit, texel: flat.data?.texel_size_px }));
  check('pivot sits at bottom-centre (16, 31)', Array.isArray(flat.data?.pivot) && flat.data.pivot[0] === 16 && flat.data.pivot[1] === 31, JSON.stringify(flat.data?.pivot));
  const flatFile = flat.data?.files?.[0];
  check('flat PNG written', flatFile && fs.existsSync(flatFile), String(flatFile));
  if (flatFile && fs.existsSync(flatFile)) {
    const img = decodePng(flatFile);
    const a = analyse(img);
    check('frame is 32x32', img.width === 32 && img.height === 32, `${img.width}x${img.height}`);
    check('alpha is binary (no semi-transparent pixels)', a.semi === 0, `${a.semi} semi-transparent`);
    const offPalette = [...a.colors.keys()].filter((c) => !SOURCE.has(c));
    check('flat mode reproduces the exact texel colours (no blends, no AA)', offPalette.length === 0 && a.colors.size >= 4, `off-palette: ${offPalette.slice(0, 6).join(', ')} (${a.colors.size} colours)`);
    check('sprite rests on the padding line (lowest pixel at y=30)', a.bounds.maxY === 30, `maxY ${a.bounds.maxY}`);
    check('sprite is 20 px tall at 1 px/unit', a.bounds.maxY - a.bounds.minY + 1 === 20, `${a.bounds.maxY - a.bounds.minY + 1}`);
    const reds = pixelsOf(img, isRed);
    const avgX = reds.reduce((s, p) => s + p[0], 0) / (reds.length || 1);
    check('side view: the nose (north) points to the RIGHT', reds.length > 0 && avgX > 16, `nose avg x ${avgX.toFixed(1)} from ${reds.length} px`);
    const greens = pixelsOf(img, isGreen);
    check('side view: the east arm faces the camera (green visible), 10 px tall', greens.length > 0 && (Math.max(...greens.map((p) => p[1])) - Math.min(...greens.map((p) => p[1])) + 1) === 10, `${greens.length} green px`);
  }

  // ── 3. front view orientation ─────────────────────────────────────────────
  console.log('\n3. front view orientation + outlined style');
  const front = await tool('pixel_art', { action: 'render', view: 'front', size: 32, style: 'flat', palette: 'none', directory: outDir, name: 'front' });
  if (front.ok && front.data?.files?.[0]) {
    const img = decodePng(front.data.files[0]);
    const greens = pixelsOf(img, isGreen), magentas = pixelsOf(img, isMagenta);
    const gx = greens.reduce((s, p) => s + p[0], 0) / (greens.length || 1);
    const mx = magentas.reduce((s, p) => s + p[0], 0) / (magentas.length || 1);
    check('front view: east arm on the image LEFT, west arm on the RIGHT (viewer-facing)', greens.length && magentas.length && gx < 16 && mx > 16, `green x ${gx.toFixed(1)}, magenta x ${mx.toFixed(1)}`);
  } else check('front view rendered', false, front.text.slice(0, 200));

  const parts = await tool('pixel_art', { action: 'render', view: 'front', size: 32, style: 'clean', inner_lines: 'parts', directory: outDir, name: 'parts' });
  check('part lines separate flush bones (arms/legs vs body)', parts.ok && (parts.data?.views?.[0]?.inner_line_pixels ?? 0) >= 10, JSON.stringify(parts.data?.views?.[0]));
  const noParts = await tool('pixel_art', { action: 'render', view: 'front', size: 32, style: 'clean', inner_lines: 'none' });
  check('inner_lines none draws no lines', noParts.ok && !noParts.data?.views?.[0]?.inner_line_pixels, JSON.stringify(noParts.data?.views?.[0]));

  const outlined = await tool('pixel_art', { action: 'render', view: 'side', size: 32, style: 'outlined', directory: outDir, name: 'outlined' });
  check('outlined style renders', outlined.ok, outlined.text.slice(0, 200));
  if (outlined.ok && outlined.data?.files?.[0]) {
    const img = decodePng(outlined.data.files[0]);
    const a = analyse(img);
    const flatImg = decodePng(flatFile);
    const fa = analyse(flatImg);
    check('outer outline grows the sprite by 1 px on each side', a.bounds.minY === fa.bounds.minY - 1 && a.bounds.maxY === fa.bounds.maxY + 1, `${JSON.stringify(a.bounds)} vs ${JSON.stringify(fa.bounds)}`);
    check('outline pixels reported', (outlined.data.views?.[0]?.colors ?? 0) > 4 && /outer/.test(outlined.data.style?.outline ?? ''), JSON.stringify(outlined.data.style));
    check('toon shading keeps the palette small (≤ 40 colours)', a.colors.size <= 40, `${a.colors.size} colours`);
    check('alpha stays binary with outline + bleed', a.semi === 0, `${a.semi} semi`);
    // The nose (north) still on the right; outline should be darker than fill.
    const reds = pixelsOf(img, isRed);
    check('shaded nose still readable as red on the right', reds.length > 0 && reds.every((p) => p[0] > 14), `${reds.length} red px`);
  }

  // ── 4. palettes ───────────────────────────────────────────────────────────
  console.log('\n4. palettes & dithering');
  const pico = await tool('pixel_art', { action: 'render', view: 'three_quarter', size: 48, palette: 'pico8', dither: 'bayer4', dither_strength: 0.5, directory: outDir, name: 'pico8' });
  check('pico8 palette render succeeds', pico.ok, pico.text.slice(0, 200));
  if (pico.ok && pico.data?.files?.[0]) {
    const PICO = new Set(presets.data ? [] : []);
    const list = ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'];
    list.forEach((c) => PICO.add(c));
    const img = decodePng(pico.data.files[0]);
    const a = analyse(img);
    const off = [...a.colors.keys()].filter((c) => !PICO.has(c));
    check('every opaque pixel is a PICO-8 colour', off.length === 0 && a.colors.size >= 3, `off: ${off.slice(0, 5).join(', ')}`);
    check('three_quarter view has coverage', a.opaque > 100, `${a.opaque} opaque`);
  }
  const auto = await tool('pixel_art', { action: 'render', view: 'isometric', size: 64, palette: 'auto', max_colors: 8, directory: outDir, name: 'auto8' });
  if (auto.ok && auto.data?.files?.[0]) {
    const a = analyse(decodePng(auto.data.files[0]));
    check('palette auto with max_colors 8 yields ≤ 8 colours', a.colors.size <= 8 && a.colors.size >= 2, `${a.colors.size}`);
  } else check('isometric auto-palette render', false, auto.text.slice(0, 200));
  const bad = await tool('pixel_art', { action: 'render', view: 'side', palette: 'not_a_palette' });
  check('unknown palette lists the valid names', !bad.ok && /pico8/.test(bad.text) && /endesga32/.test(bad.text), bad.text.slice(0, 160));
  const badView = await tool('pixel_art', { action: 'render', view: 'diagonal' });
  check('unknown view lists the presets', !badView.ok && /three_quarter/.test(badView.text), badView.text.slice(0, 160));

  // ── 5. sprite sheet export ────────────────────────────────────────────────
  console.log('\n5. sprite sheet export (walk, 4 directions)');
  const sheet = await tool('pixel_art', { action: 'export_sheet', animation: 'walk', fps: 8, directions: 4, size: 32, output: { directory: outDir, name: 'walk4', frames: true, normal_map: true } });
  check('export_pixel_sprites succeeds with a preview image', sheet.ok && sheet.content.some((c) => c.type === 'image'), sheet.text.slice(0, 400));
  if (sheet.ok) {
    const d = sheet.data;
    check('4 frames per direction at 8 fps for a 0.5 s loop', d.animations?.[0]?.frames === 4, JSON.stringify(d.animations));
    check('sheet is 4 columns x 4 rows with 1 px padding (131x131)', d.sheet?.width === 131 && d.sheet?.height === 131 && d.sheet?.columns === 4 && d.sheet?.rows === 4, JSON.stringify(d.sheet));
    const names = (d.directions || []).map((x) => x.name).sort().join(',');
    check('side-based direction set is right/up/left/down', names === 'down,left,right,up', names);
    check('frame tags carry animation + direction', Array.isArray(d.frame_tags) && d.frame_tags.length === 4 && d.frame_tags.every((t) => /^walk_/.test(t.name) && t.to - t.from === 3), JSON.stringify(d.frame_tags));
    check('sheet, json, normal map and frames written', d.files?.sheet && d.files?.json && d.files?.normal_map && d.files?.frame_count === '16' && fs.existsSync(d.files.sheet) && fs.existsSync(d.files.json), JSON.stringify(d.files));
    if (d.files?.json && fs.existsSync(d.files.json)) {
      const json = JSON.parse(fs.readFileSync(d.files.json, 'utf8'));
      const frames = Object.values(json.frames);
      check('Aseprite JSON: 16 frames with 125 ms durations', frames.length === 16 && frames.every((f) => f.duration === 125 && f.frame.w === 32 && f.frame.h === 32), `${frames.length} frames`);
      check('Aseprite JSON: meta size matches the sheet and pivot slice exists', json.meta?.size?.w === 131 && json.meta?.slices?.[0]?.name === 'pivot' && json.meta.slices[0].keys.length === 16 && json.meta.slices[0].keys[0].pivot.y === 31, JSON.stringify(json.meta?.slices?.[0]?.keys?.[0]));
      check('Aseprite JSON: pixelart block has ppu + directions', json.meta?.pixelart?.pixels_per_unit === 1 && json.meta.pixelart.directions.length === 4, JSON.stringify(json.meta?.pixelart?.directions));
      const img = decodePng(d.files.sheet);
      check('sheet PNG dimensions match', img.width === 131 && img.height === 131, `${img.width}x${img.height}`);
      // Cell (col 0,row 0) and (col 1,row 0) must differ (animation moves the arm).
      const cell = (col, row) => { const pts = []; for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const i = ((row * 33 + y) * img.width + col * 33 + x) * 4; pts.push(img.data[i + 3] ? hex(img.data[i], img.data[i + 1], img.data[i + 2]) : '-'); } return pts.join(''); };
      check('animation frames differ across the row', cell(0, 0) !== cell(1, 0), 'frames identical');
      const nimg = decodePng(d.files.normal_map);
      const na = analyse(nimg);
      check('normal map has the same coverage as the sheet', na.opaque === analyse(img).opaque && na.opaque > 0, `${na.opaque} vs ${analyse(img).opaque}`);
    }
  }

  // ── 6. mirrored 8-direction set ───────────────────────────────────────────
  console.log('\n6. mirrored 8 directions');
  const eight = await tool('pixel_art', { action: 'export_sheet', view: 'three_quarter', directions: 8, mirror_directions: true, size: 32, style: 'clean', output: { directory: outDir, name: 'eight', frames: true } });
  check('8-direction static export succeeds', eight.ok, eight.text.slice(0, 300));
  if (eight.ok) {
    const d = eight.data;
    const mirrored = (d.directions || []).filter((x) => x.mirrored_from);
    check('3 of 8 directions are mirrored copies', mirrored.length === 3 && mirrored.every((m) => ['down_right', 'right', 'up_right'].includes(m.mirrored_from)), JSON.stringify(mirrored));
    check('8 direction names are the screen set', (d.directions || []).map((x) => x.name).join(',') === 'down,down_right,right,up_right,up,up_left,left,down_left', (d.directions || []).map((x) => x.name).join(','));
    const img = decodePng(d.files.sheet);
    // right = row 2, left = row 6 → left must equal right flipped.
    const px = (col, row, x, y) => { const i = ((row * 33 + y) * img.width + col * 33 + x) * 4; return img.data[i + 3] ? hex(img.data[i], img.data[i + 1], img.data[i + 2]) : '-'; };
    let same = 0, total = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { total++; if (px(0, 2, x, y) === px(0, 6, 31 - x, y)) same++; }
    check('mirrored "left" frame equals flipped "right" frame', same === total, `${same}/${total}`);
    check('static export uses one row per direction (8 rows)', d.sheet?.rows === 8 && d.sheet?.columns === 1, JSON.stringify(d.sheet));
  }

  // ── 7. sizes ──────────────────────────────────────────────────────────────
  console.log('\n7. sizes & explicit scale');
  // 20-unit model, 1 px padding: 16 px → 14/20 = 0.7 → ½ texel; 64 → 62/20 = 3.1 → 3; 128 → 126/20 = 6.3 → 6.
  for (const [size, ppu] of [[16, 0.5], [64, 3], [128, 6]]) {
    const r = await tool('pixel_art', { action: 'render', view: 'side', size, directory: outDir, name: `size${size}` });
    const ok = r.ok && r.data?.frame_size?.[0] === size;
    check(`size ${size} auto-fits to ${ppu} px per unit`, ok && r.data.pixels_per_unit === ppu && !r.data.warnings, JSON.stringify({ ppu: r.data?.pixels_per_unit, warnings: r.data?.warnings }));
  }
  const clipped = await tool('pixel_art', { action: 'render', view: 'side', size: 16, pixels_per_unit: 2 });
  check('a too-large explicit scale warns about clipping', clipped.ok && Array.isArray(clipped.data?.warnings) && /cut off/.test(clipped.data.warnings.join(' ')), clipped.text.slice(0, 200));

  // ── cleanup ──────────────────────────────────────────────────────────────
  for (const uuid of scratch.reverse()) {
    if (!uuid) continue;
    const sel = await tool('project_file', { action: 'switch_tab', uuid });
    if (sel.ok) await tool('project_file', { action: 'close', force: true });
  }
  if (originalTab) await tool('project_file', { action: 'switch_tab', uuid: originalTab });

  console.log(`\n${failures.length ? 'FAILED' : 'OK'} — ${passed} passed, ${failures.length} failed. Outputs: ${outDir}`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\nERROR: ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  child.kill();
}
