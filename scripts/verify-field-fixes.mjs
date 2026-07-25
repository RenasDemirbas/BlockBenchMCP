// Regression test for the v1.3 field-feedback fixes. Blockbench must be running.
//
//   node scripts/verify-field-fixes.mjs
//
// Read-only checks run against whatever project is open; the animation-timing
// checks need their own scratch project, which is created, tested and closed,
// restoring the tab that was selected on entry.
import { spawn } from 'node:child_process';
import path from 'node:path';
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

/** Call a tool. Returns {ok, data, text} — a tool-level error is data, not a throw. */
async function tool(name, args = {}) {
  const res = await rpc('tools/call', { name, arguments: args });
  if (res.error) return { ok: false, text: JSON.stringify(res.error), data: null };
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

const nearly = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

try {
  await new Promise((r) => setTimeout(r, 1200));
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-field-fixes', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const status = await tool('get_status');
  if (!status.data?.connected) throw new Error('Blockbench is not connected — start it and enable the MCP bridge plugin.');
  const originalTab = status.data.open_tabs?.find((t) => t.selected)?.uuid ?? null;
  console.log(`Blockbench ${status.data.blockbench_version}, plugin ${status.data.plugin_version}\n`);

  // ── 1. eval_code: native-module guard ───────────────────────────────────
  console.log('1. eval_code hardening');
  const osReq = await tool('eval_code', { code: "require('os').homedir()", undo: false });
  check('require("os") is refused before it can open the modal', !osReq.ok && /refused to run/.test(osReq.text), osReq.text.slice(0, 120));
  check('the refusal points at the paths alternative', /get_status|SystemInfo/.test(osReq.text));
  const fsReq = await tool('eval_code', { code: "const fs = require('node:fs'); fs.existsSync('/')", undo: false });
  check('node:-prefixed fs is refused too', !fsReq.ok && /refused to run/.test(fsReq.text));
  const dynReq = await tool('eval_code', { code: 'const m = "os"; require(m)', undo: false });
  check('computed require() is refused', !dynReq.ok && /refused to run/.test(dynReq.text));
  const safeReq = await tool('eval_code', { code: "require('path').join('a','b')", undo: false });
  check('safe module (path) still loads', safeReq.ok && safeReq.data?.result === 'a\\b' || safeReq.data?.result === 'a/b', safeReq.text.slice(0, 120));

  // ── 1b. eval_code: top-level return / await ─────────────────────────────
  const topReturn = await tool('eval_code', { code: 'const n = Cube.all.length;\nreturn { cubes: n };', undo: false });
  check('top-level return works without an IIFE', topReturn.ok && typeof topReturn.data?.result?.cubes === 'number', topReturn.text.slice(0, 160));
  const topAwait = await tool('eval_code', { code: 'const v = await Promise.resolve(21);\nreturn v * 2;', undo: false });
  check('top-level await works', topAwait.ok && topAwait.data?.result === 42, topAwait.text.slice(0, 160));
  const expr = await tool('eval_code', { code: '1 + 1', undo: false });
  check('plain expression still returns its value', expr.ok && expr.data?.result === 2, expr.text.slice(0, 120));
  const stmts = await tool('eval_code', { code: 'const a = 3; const b = 4; a * b', undo: false });
  check('statement list still returns the last expression', stmts.ok && stmts.data?.result === 12, stmts.text.slice(0, 120));
  const jsonErr = await tool('eval_code', { code: 'JSON.parse("{oops}")', undo: false });
  check('a runtime SyntaxError is NOT silently re-run', !jsonErr.ok && /eval error/.test(jsonErr.text));

  // ── 2. paths ────────────────────────────────────────────────────────────
  console.log('\n2. path discovery');
  check('get_status reports home/desktop/temp', !!(status.data.paths?.home && status.data.paths?.desktop && status.data.paths?.temp), JSON.stringify(status.data.paths));
  const info = await tool('get_project_info');
  check('get_project_info adds last-used folders', !!info.data?.paths?.last_used, JSON.stringify(info.data?.paths ?? null).slice(0, 200));
  check('get_project_info adds recent project paths', Array.isArray(info.data?.paths?.recent_projects));

  // ── 3. cube targeting ───────────────────────────────────────────────────
  console.log('\n3. cube targeting');
  const scratchName = `mcp_verify_${Date.now().toString(36)}`;
  const created = await tool('create_project', { format: 'bedrock', name: scratchName });
  if (!created.ok) throw new Error(`could not create scratch project: ${created.text}`);
  await tool('add_groups', { groups: [{ name: 'root' }, { name: 'body', parent: 'root' }] });
  await tool('add_cubes', { cubes: [{ name: 'torso', parent: 'body', from: [-4, 0, -2], to: [4, 10, 2] }] });
  // paint_faces needs a texture on the faces, so set it up before painting.
  await tool('create_texture', { name: 'verify_tex', width: 64, height: 64, color: '#888888' });
  await tool('generate_texture_template', {});

  const emptyRoot = await tool('paint_faces', { targets: [{ element: 'root', faces: 'all', color: '#ff0000' }] });
  check('empty "root" group fails with a useful message',
    !emptyRoot.ok && /holds no cubes/.test(emptyRoot.text) && /"\*"/.test(emptyRoot.text) && /body/.test(emptyRoot.text),
    emptyRoot.text.slice(0, 220));
  const wildcard = await tool('paint_faces', { targets: [{ element: '*', faces: ['north'], color: '#3366ff' }] });
  check('"*" paints every cube in the model', wildcard.ok && /torso/.test(wildcard.text), wildcard.text.slice(0, 160));

  // ── 4/5. keyframe timing + rest rotation ────────────────────────────────
  console.log('\n4. keyframe timing');
  await tool('update_elements', { elements: [{ id: 'body', rotation: [0, 25, 0] }] });
  await tool('create_animation', { name: 'verify.clip', loop: 'loop', snapping: 24 });

  const snapped = await tool('set_keyframes', {
    animation: 'verify.clip',
    bones: [{ bone: 'body', channel: 'rotation', keyframes: [{ time: 0, values: [0, 0, 0] }, { time: 0.3, values: [10, 0, 0] }, { time: 1.2, values: [0, 0, 0] }] }],
  });
  check('snapping is reported instead of happening silently',
    snapped.ok && Array.isArray(snapped.data?.snapped?.moved) && snapped.data.snapped.moved.length === 2,
    JSON.stringify(snapped.data?.snapped ?? null).slice(0, 220));
  check('the snap warning names the fps grid and the escape hatch',
    /snap.*false/.test(JSON.stringify(snapped.data?.snapped ?? {})) && snapped.data?.snapped?.snapping_fps === 24);
  check('rest rotation is surfaced on the bone',
    Array.isArray(snapped.data?.bones?.[0]?.rest_rotation) && /ADD/.test(snapped.data.bones[0].rest_note ?? ''),
    JSON.stringify(snapped.data?.bones?.[0] ?? null).slice(0, 200));

  const exact = await tool('set_keyframes', {
    animation: 'verify.clip', snap: false,
    bones: [{ bone: 'body', channel: 'position', keyframes: [{ time: 0.3, values: [0, 1, 0] }, { time: 1.2, values: [0, 0, 0] }] }],
  });
  check('snap:false writes exact times', exact.ok && !exact.data?.snapped && exact.data.bones[0].times.includes(0.3) && exact.data.bones[0].times.includes(1.2),
    JSON.stringify(exact.data?.bones?.[0] ?? null).slice(0, 200));

  // Retime the snapped rotation keyframes onto exact times, then shorten.
  const retimed = await tool('edit_keyframes', {
    animation: 'verify.clip', bone: 'body', channel: 'rotation',
    time_range: [1.2, 1.3], set_time: 1.2, snap: false,
  });
  check('edit_keyframes set_time moves a keyframe to an exact time', retimed.ok && nearly(retimed.data?.content_length ?? -1, 1.2),
    JSON.stringify({ length: retimed.data?.length, content: retimed.data?.content_length }));

  const shortened = await tool('edit_keyframes', {
    animation: 'verify.clip', bone: 'body', channel: 'rotation', time_range: [1.2, 1.2], resize_to_content: true,
  });
  check('resize_to_content shrinks the clip back to its content', shortened.ok && nearly(shortened.data?.length ?? -1, 1.2),
    `length=${shortened.data?.length}`);

  const shorter = await tool('update_animation', { id: 'verify.clip', length: 0.8 });
  check('update_animation honours a SHORTER length', shorter.ok && nearly(shorter.data?.length ?? -1, 0.8), `length=${shorter.data?.length}`);
  check('and warns about keyframes left past the end', /past the animation length/i.test(shorter.data?.warning ?? ''), (shorter.data?.warning ?? '').slice(0, 160));

  const del = await tool('edit_keyframes', { animation: 'verify.clip', bone: 'body', channel: 'position', delete: true, resize_to_content: true });
  check('edit_keyframes deletes keyframes', del.ok && del.data?.deleted === 2, JSON.stringify(del.data ?? null).slice(0, 160));

  // ── 6. get_texture cropping ─────────────────────────────────────────────
  console.log('\n5. get_texture cropping');
  const whole = await tool('get_texture', {});
  check('whole-atlas mode still works', whole.ok && whole.content.some((c) => c.type === 'image'), whole.text.slice(0, 120));
  const cropped = await tool('get_texture', { element: 'torso', face: 'north', max_size: 256 });
  const region = cropped.data?.cropped_to;
  check('element+face crop returns a region', cropped.ok && !!region && region.width > 0 && region.height > 0, JSON.stringify(region ?? null));
  check('the crop is smaller than the atlas', !!region && (region.width < 64 || region.height < 64), JSON.stringify(region ?? null));
  check('the crop is zoomed in', (region?.zoom ?? 0) > 1, `zoom=${region?.zoom}`);
  check('the crop names the face it covers', region?.faces?.[0]?.face === 'torso.north', JSON.stringify(region?.faces ?? null));
  check('the crop returns an image', cropped.content.some((c) => c.type === 'image'));
  const padded = await tool('get_texture', { element: 'torso', face: 'north', padding: 2 });
  check('padding widens the crop', (padded.data?.cropped_to?.width ?? 0) > (region?.width ?? 0),
    `${region?.width} -> ${padded.data?.cropped_to?.width}`);
  const wholeModel = await tool('get_texture', { element: '*', faces: 'all' });
  check('"*" crops to every face', wholeModel.ok && (wholeModel.data?.cropped_to?.faces?.length ?? 0) >= 6,
    `${wholeModel.data?.cropped_to?.faces?.length} faces`);

  // ── cleanup ─────────────────────────────────────────────────────────────
  await tool('close_project', { force: true });
  if (originalTab) await tool('select_project_tab', { uuid: originalTab });
  const after = await tool('get_status');
  check('scratch project closed and the original tab restored',
    !after.data?.open_tabs?.some((t) => t.name?.includes(scratchName))
    && (!originalTab || after.data?.open_tabs?.find((t) => t.selected)?.uuid === originalTab),
    JSON.stringify(after.data?.open_tabs ?? null));

  console.log(`\n${failures.length ? 'FAILED' : 'OK'} — ${passed} passed, ${failures.length} failed`);
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
