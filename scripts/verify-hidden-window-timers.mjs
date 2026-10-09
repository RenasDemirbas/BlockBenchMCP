// Regression test for the "generate_texture_template times out while the
// Blockbench window is hidden" bug.
//
// Root cause: Blockbench's TextureGenerator.generateTemplate cooperatively
// yields with `await new Promise(r => setTimeout(r, 1))`. Chromium aligns timer
// wake-ups in a HIDDEN page to ~1/second, so every yield costs ~1s instead of
// ~1ms and a few hundred faces blow past the MCP timeout.
//
// This test is only meaningful while the Blockbench window is minimized /
// covered / on another desktop (document.visibilityState === 'hidden'); it says
// so loudly and skips the assertions otherwise.
//
// It never touches the user's open project: it creates its own scratch tab,
// works there, closes it and switches back.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CUBES = Number(process.env.PROBE_CUBES || 55);
const BUDGET_MS = Number(process.env.PROBE_BUDGET_MS || 20000);

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
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${extra ? ` — ${String(extra).slice(0, 300)}` : ''}`);
  if (!cond) failed = true;
};

async function tool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res.result?.content?.find((c) => c.type === 'text')?.text || '';
  let json = null; try { json = JSON.parse(text); } catch {}
  return { text, json, isError: res.result?.isError === true };
}

let originalTab = null;
let scratchOpen = false;

try {
  await sleep(1200);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-timers', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const status = await tool('get_status', {});
  check('connected to Blockbench', status.json?.connected === true, status.json?.blockbench_version);
  if (status.json?.connected !== true) throw new Error('not connected');
  originalTab = status.json?.project?.uuid || null;

  // ── 1. Is the window actually hidden, and how bad is the raw timer? ──────────
  // Scheduled first, read later: under throttling a 6-link setTimeout chain can
  // outlive the MCP call timeout, so we must never await it inside eval_code.
  await tool('eval_code', {
    undo: false,
    code: `(() => {
      const N = 6;
      const P = window.__mcp_timer_probe = { t0: performance.now(), visibility: document.visibilityState, raw: [], patched: [] };
      const raw = (window.__mcp_native_setTimeout || window.setTimeout);
      const stepRaw = () => { P.raw.push(Math.round(performance.now() - P.t0)); if (P.raw.length < N) raw(stepRaw, 1); };
      raw(stepRaw, 1);
      const stepPatched = () => { P.patched.push(Math.round(performance.now() - P.t0)); if (P.patched.length < N) setTimeout(stepPatched, 1); };
      setTimeout(stepPatched, 1);
      return 'scheduled';
    })()`,
  });
  await sleep(9000);
  const probe = await tool('eval_code', {
    undo: false,
    code: `(() => { const P = window.__mcp_timer_probe; return { visibility: P.visibility, raw_ms: P.raw, patched_ms: P.patched, backend: (window.__mcp_timer_backend || 'native') }; })()`,
  });
  const visibility = probe.json?.result?.visibility;
  const raw = probe.json?.result?.raw_ms || [];
  const patched = probe.json?.result?.patched_ms || [];
  console.log(`   visibility=${visibility} backend=${probe.json?.result?.backend}`);
  console.log(`   unpatched setTimeout(…,1) chain: [${raw.join(', ')}] ms`);
  console.log(`   plugin  setTimeout(…,1) chain: [${patched.join(', ')}] ms`);

  const hidden = visibility === 'hidden';
  if (!hidden) {
    console.log('\n   NOTE: the Blockbench window is VISIBLE, so Chromium is not throttling');
    console.log('   timers and this test cannot reproduce the bug. Minimize Blockbench');
    console.log('   (or cover it completely) and run again.\n');
  } else {
    check('unpatched timers ARE throttled while hidden (this is the bug)', raw.length < 6 || raw[raw.length - 1] > 900, `last=${raw[raw.length - 1]}ms`);
    check('plugin timers are NOT throttled while hidden', patched.length === 6 && patched[5] < 300, `6 chained yields in ${patched[5]}ms`);
  }

  // ── 2. End-to-end: the tool that actually broke ──────────────────────────────
  const scratch = await tool('create_project', { format: 'free', name: 'mcp_timer_probe' });
  check('scratch project created', !scratch.isError, scratch.text.slice(0, 120));
  scratchOpen = !scratch.isError;

  const cubes = Array.from({ length: CUBES }, (_, i) => {
    const x = (i % 11) * 5, z = Math.floor(i / 11) * 5;
    return { name: `c${i}`, from: [x, 0, z], to: [x + 4, 4, z + 4] };
  });
  const added = await tool('add_cubes', { cubes });
  check(`${CUBES} cubes added (${CUBES * 6} faces)`, !added.isError, added.text.slice(0, 120));

  const t0 = Date.now();
  const gen = await tool('generate_texture_template', { pixel_density: 16, name: 'probe_template' });
  const elapsed = Date.now() - t0;
  console.log(`   generate_texture_template took ${elapsed} ms`);
  check('generate_texture_template succeeded', !gen.isError, gen.text.slice(0, 200));
  check(`generate_texture_template finished within ${BUDGET_MS} ms`, !gen.isError && elapsed < BUDGET_MS, `${elapsed} ms`);
  const leftover = await tool('eval_code', { undo: false, code: `(() => ({ open: Dialog.open ? Dialog.open.id : null }))()` });
  check('Blockbench is not left wedged behind a modal dialog', leftover.json?.result?.open == null, `Dialog.open=${leftover.json?.result?.open}`);

  console.log(failed ? '\nVERIFY FAILED' : '\nVERIFY PASSED');
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
