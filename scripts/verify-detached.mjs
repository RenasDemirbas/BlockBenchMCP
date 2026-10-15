// Verifies validate_model's detached-part check against a live Blockbench:
//   * a correctly attached rig (body > leg > paw) reports nothing
//   * a leg 1 unit below the body and a paw 1 unit beside its leg are reported
//     with bone, nearest neighbour and the [x,y,z] gap
//   * at animation times: a leg keyed back up to the body is attached at that time
//   * detached: false turns the check off
//
// Spawns its own dist/mcp-server.js and works in a scratch project tab, so the
// user's models are never touched.
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
let originalTab = null;
let scratchOpen = false;
const names = (list) => (list || []).map((d) => d.element).sort().join(',');

try {
  await sleep(1200);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-detached', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const status = await tool('get_status', {});
  check('connected to Blockbench', status.json?.connected === true, status.json?.blockbench_version);
  if (status.json?.connected !== true) throw new Error('not connected');
  originalTab = status.json?.project?.uuid || null;

  const scratch = await tool('create_project', { format: 'bedrock', name: 'mcp_detached_probe' });
  check('scratch project created', !scratch.isError, scratch.text.slice(0, 80));
  scratchOpen = !scratch.isError;

  // Attached rig: an empty root bone; body; leg as child of body; paw as child of leg (overlaps the leg).
  // A second leg hangs as a SIBLING of body under the empty root bone, the vanilla quadruped layout.
  await tool('add_groups', { groups: [
    { name: 'root' },
    { name: 'body', parent: 'root', origin: [0, 6, 0] },
    { name: 'leg', parent: 'body', origin: [-2, 6, -4] },
    { name: 'paw', parent: 'leg', origin: [-2, 1, -4] },
    { name: 'leg_sib', parent: 'root', origin: [2, 6, 4] },
  ] });
  const add = await tool('add_cubes', { cubes: [
    { name: 'body_c', parent: 'body', from: [-4, 6, -6], to: [4, 12, 6] },
    { name: 'leg_c', parent: 'leg', from: [-3, 0, -5], to: [-1, 6, -3] },
    { name: 'paw_c', parent: 'paw', from: [-3, 0, -6], to: [-1.5, 1, -3] },
    { name: 'leg_sib_c', parent: 'leg_sib', from: [1, 0, 3], to: [3, 6, 5] },
  ] });
  check('attached rig built', !add.isError, add.text.slice(0, 120));

  const ok = await tool('validate_model', { checks: false, intersections: false });
  check('attached rig: nothing detached', !ok.isError && ok.json?.detached_count === 0, ok.text.slice(0, 220));

  // Broken parts: a leg 1 unit below the body, and a paw cube 1 unit beside its leg (same bone as the leg).
  await tool('add_groups', { groups: [{ name: 'leg_low', parent: 'body', origin: [2, 5, -4] }] });
  await tool('add_cubes', { cubes: [
    { name: 'leg_low_c', parent: 'leg_low', from: [1, -1, -5], to: [3, 5, -3] },
    { name: 'paw_off_c', parent: 'leg', from: [0, 0, -5], to: [0.5, 1, -3] },
  ] });
  const bad = await tool('validate_model', { checks: false, intersections: false });
  const d = bad.json?.detached || [];
  const low = d.find((x) => x.element === 'leg_low_c');
  const off = d.find((x) => x.element === 'paw_off_c');
  check('broken rig: exactly the two broken parts are detached', names(d) === 'leg_low_c,paw_off_c' && bad.json?.detached_count === 2, bad.text.slice(0, 300));
  check('floating leg: bone, nearest = body, gap [0,1,0]', low?.bone === 'leg_low' && low?.nearest === 'body_c' && JSON.stringify(low?.gap) === '[0,1,0]' && low?.distance === 1, JSON.stringify(low));
  check('offset paw: nearest = its leg, gap [1,0,0]', off?.bone === 'leg' && off?.nearest === 'leg_c' && JSON.stringify(off?.gap) === '[1,0,0]', JSON.stringify(off));

  const offCheck = await tool('validate_model', { checks: false, intersections: false, detached: false });
  check('detached: false skips the check', !offCheck.isError && offCheck.json?.detached === undefined, offCheck.text.slice(0, 120));
  const tol = await tool('validate_model', { checks: false, intersections: false, tolerance: 1.01 });
  check('tolerance covers a 1-unit gap', tol.json?.detached_count === 0, tol.text.slice(0, 160));

  // At animation times: the low leg is keyed 1 unit up at t=0.5, so it touches the body there only.
  await tool('create_animation', { name: 'animation.probe.lift', loop: 'loop', length: 1 });
  await tool('set_keyframes', { animation: 'animation.probe.lift', bones: [
    { bone: 'leg_low', channel: 'position', keyframes: [{ time: 0, values: [0, 0, 0] }, { time: 0.5, values: [0, 1, 0] }, { time: 1, values: [0, 0, 0] }] },
  ] });
  const anim = await tool('validate_model', { checks: false, intersections: false, animation: 'animation.probe.lift', times: [0, 0.5] });
  const [t0, t5] = anim.json?.by_time || [];
  check('t=0: floating leg detached', !anim.isError && names(t0?.detached).includes('leg_low_c'), anim.text.slice(0, 300));
  check('t=0.5: leg keyed up to the body is attached', t5 && !names(t5.detached).includes('leg_low_c') && t5.detached_count === 1, JSON.stringify(t5));
  const both = await tool('validate_model', { checks: false, animation: 'animation.probe.lift', times: [0] });
  check('intersections and detached share one sweep', Array.isArray(both.json?.by_time?.[0]?.intersections) && both.json?.by_time?.[0]?.detached_count === 2, both.text.slice(0, 200));

  console.log(failed ? `\nDETACHED VERIFY FAILED (${passes} passed)` : `\nDETACHED VERIFY PASSED (${passes} checks)`);
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
