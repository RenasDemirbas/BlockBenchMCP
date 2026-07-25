// Verifies the v1.2 painting additions against a live Blockbench:
//   * paint_texture "target": {element: <group>, faces: "all"}  → bulk expansion
//   * gradient "stops": multi-stop ramps
//   * gradient "space": "world" → shading continuous ACROSS cubes (the fix for
//     multi-cube limbs looking banded)
//   * "strands" op → fur dashes scaled to each face
//   * "noise" with no target and no from/to → whole bitmap
//   * inspect_uv → structural UV report
//
// Spawns its own dist/mcp-server.js so the new tool schemas are in play (a
// running chat session's tool list is fixed at startup), and works in its own
// scratch project tab so the user's model is never touched.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

let originalTab = null;
let scratchOpen = false;

try {
  await sleep(1200);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-paint-ops', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const status = await tool('get_status', {});
  check('connected to Blockbench', status.json?.connected === true, status.json?.blockbench_version);
  if (status.json?.connected !== true) throw new Error('not connected');
  originalTab = status.json?.project?.uuid || null;

  const scratch = await tool('create_project', { format: 'free', name: 'mcp_paintops_probe' });
  check('scratch project created', !scratch.isError, scratch.text.slice(0, 80));
  scratchOpen = !scratch.isError;

  // A three-segment vertical limb: the exact shape that exposes per-cube banding.
  await tool('add_groups', { groups: [{ name: 'limb', origin: [2, 0, 2] }] });
  const cubes = await tool('add_cubes', {
    cubes: [
      { name: 'seg_bottom', parent: 'limb', from: [0, 0, 0], to: [4, 8, 4] },
      { name: 'seg_mid', parent: 'limb', from: [0, 8, 0], to: [4, 16, 4] },
      { name: 'seg_top', parent: 'limb', from: [0, 16, 0], to: [4, 24, 4] },
    ],
  });
  check('3-segment limb added', !cubes.isError, cubes.text.slice(0, 80));

  const tpl = await tool('generate_texture_template', { pixel_density: 32, name: 'probe_tex' });
  check('template generated', !tpl.isError, `${tpl.json?.texture?.width}x${tpl.json?.texture?.height}`);

  // ── 1. inspect_uv on a freshly templated model: no shared rects ─────────────
  const insp1 = await tool('inspect_uv', {});
  check('inspect_uv runs', !insp1.isError, insp1.text.slice(0, 120));
  check('inspect_uv sees 18 faces', insp1.json?.faces === 18, `faces=${insp1.json?.faces}`);
  check('inspect_uv reports no shared UV rects after templating', insp1.json?.shared_uv_rects === undefined, JSON.stringify(insp1.json?.shared_uv_rects));
  check('inspect_uv reports the 2px/unit scale', insp1.json?.textures?.[0]?.pixels_per_uv_unit?.[0] === 2, JSON.stringify(insp1.json?.textures?.[0]?.pixels_per_uv_unit));
  check('inspect_uv finds no stretched/rotated faces', !insp1.json?.stretched && !insp1.json?.rotated && !insp1.json?.axes_swapped);

  // ── 2. bulk targeting: one op over a group with faces "all" → 18 face ops ───
  const bulk = await tool('paint_texture', {
    ops: [{ type: 'rect', target: { element: 'limb', faces: 'all' }, from: [0, 0], to: [1, 1], filled: true, color: '#808080' }],
  });
  check('bulk group target expands 1 op to 18', !bulk.isError && bulk.json?.ops_applied === 18, `ops_applied=${bulk.json?.ops_applied} requested=${bulk.json?.ops_requested}`);

  // ── 3. whole-bitmap noise (no target, no from/to) ───────────────────────────
  const wholeNoise = await tool('paint_texture', {
    ops: [{ type: 'noise', color: '#ff0000', density: 1, opacity: 1, seed: 5 }],
  });
  check('noise with no target/rect covers the whole bitmap', !wholeNoise.isError, wholeNoise.text.slice(0, 140));
  const redAll = await tool('eval_code', {
    undo: false,
    code: `(() => { const t = Texture.all[0]; const c = document.createElement('canvas'); c.width=t.width; c.height=t.height; const x=c.getContext('2d'); x.drawImage(t.img,0,0); const d=x.getImageData(0,0,t.width,t.height).data; let red=0,tot=0; for(let i=0;i<d.length;i+=4){tot++; if(d[i]>200&&d[i+1]<60&&d[i+2]<60) red++;} return {red, tot, pct: Math.round(100*red/tot)}; })()`,
  });
  check('whole-bitmap noise reached every corner', redAll.json?.result?.pct >= 99, `red=${redAll.json?.result?.pct}%`);

  // Repaint a clean base for the gradient test.
  await tool('paint_faces', { targets: [{ element: 'limb', color: '#808080' }] });

  // ── 4. world-space gradient continuity ─────────────────────────────────────
  // White at the model top (at 0), black at the bottom (at 1). Continuous shading
  // means the bottom row of seg_top matches the top row of seg_mid.
  const grad = await tool('paint_texture', {
    ops: [{
      type: 'gradient',
      target: { element: 'limb', faces: ['north', 'south', 'east', 'west'] },
      space: 'world',
      stops: [{ at: 0, color: '#ffffff' }, { at: 1, color: '#000000' }],
    }],
  });
  check('world-space gradient expands to 12 side faces', !grad.isError && grad.json?.ops_applied === 12, `ops_applied=${grad.json?.ops_applied}`);

  const probe = await tool('eval_code', {
    undo: false,
    code: `(() => {
      const t = Texture.all[0];
      const c = document.createElement('canvas'); c.width=t.width; c.height=t.height;
      const x = c.getContext('2d'); x.drawImage(t.img,0,0);
      const fx = t.width/t.getUVWidth(), fy = t.height/t.getUVHeight();
      const lum = (px,py) => { const d = x.getImageData(px,py,1,1).data; return Math.round((d[0]+d[1]+d[2])/3); };
      const out = {};
      ['seg_bottom','seg_mid','seg_top'].forEach(n => {
        const el = Project.elements.find(e => e.name === n);
        const uv = el.faces.north.uv;
        const px = Math.round(Math.min(uv[0],uv[2])*fx) + 1;
        const y0 = Math.round(Math.min(uv[1],uv[3])*fy);
        const y1 = Math.round(Math.max(uv[1],uv[3])*fy);
        out[n] = { top: lum(px, y0), bottom: lum(px, y1 - 1), rect_h: y1 - y0 };
      });
      return out;
    })()`,
  });
  const g = probe.json?.result || {};
  console.log(`   luminance  seg_top=${g.seg_top?.top}→${g.seg_top?.bottom}  seg_mid=${g.seg_mid?.top}→${g.seg_mid?.bottom}  seg_bottom=${g.seg_bottom?.top}→${g.seg_bottom?.bottom}`);
  const seamA = Math.abs((g.seg_top?.bottom ?? 0) - (g.seg_mid?.top ?? 999));
  const seamB = Math.abs((g.seg_mid?.bottom ?? 0) - (g.seg_bottom?.top ?? 999));
  check('gradient descends monotonically down the whole limb',
    g.seg_top?.top > g.seg_top?.bottom && g.seg_top?.bottom >= g.seg_mid?.top - 12
    && g.seg_mid?.top > g.seg_mid?.bottom && g.seg_mid?.bottom >= g.seg_bottom?.top - 12
    && g.seg_bottom?.top > g.seg_bottom?.bottom,
    `${g.seg_top?.top}→${g.seg_bottom?.bottom}`);
  check('seam seg_top/seg_mid is continuous (no banding)', seamA <= 12, `luminance jump = ${seamA}`);
  check('seam seg_mid/seg_bottom is continuous (no banding)', seamB <= 12, `luminance jump = ${seamB}`);
  check('each segment only spans part of the ramp', (g.seg_top?.top - g.seg_top?.bottom) < 170, `seg_top spread=${g.seg_top?.top - g.seg_top?.bottom} (a face-local ramp would be ~255)`);

  // ── 5. strands op ──────────────────────────────────────────────────────────
  const before = await tool('eval_code', { undo: false, code: `(() => { const t=Texture.all[0]; const c=document.createElement('canvas'); c.width=t.width;c.height=t.height; const x=c.getContext('2d'); x.drawImage(t.img,0,0); const d=x.getImageData(0,0,t.width,t.height).data; let s=0; for(let i=0;i<d.length;i+=4) s+=d[i]; return s; })()` });
  const strands = await tool('paint_texture', {
    ops: [{
      type: 'strands', target: { element: 'limb', faces: 'all' },
      color: '#000000', color2: '#ffffff', density: 0.2, length: [0.1, 0.3],
      light_ratio: 0.35, opacity: 0.8, opacity2: 0.6, root: 0.12, seed: 11,
    }],
  });
  check('strands op expands to 18 faces', !strands.isError && strands.json?.ops_applied === 18, `ops_applied=${strands.json?.ops_applied} ${strands.text.slice(0, 120)}`);
  const after = await tool('eval_code', { undo: false, code: `(() => { const t=Texture.all[0]; const c=document.createElement('canvas'); c.width=t.width;c.height=t.height; const x=c.getContext('2d'); x.drawImage(t.img,0,0); const d=x.getImageData(0,0,t.width,t.height).data; let s=0; for(let i=0;i<d.length;i+=4) s+=d[i]; return s; })()` });
  check('strands actually changed pixels', before.json?.result !== after.json?.result, `${before.json?.result} → ${after.json?.result}`);

  // ── 6. determinism: the same seed must produce the same pixels ──────────────
  await tool('paint_faces', { targets: [{ element: 'limb', color: '#808080' }] });
  const strandArgs = { ops: [{ type: 'strands', target: { element: 'limb', faces: 'all' }, color: '#000000', density: 0.2, opacity: 1, seed: 77 }] };
  await tool('paint_texture', strandArgs);
  const runA = await tool('eval_code', { undo: false, code: `(() => { const t=Texture.all[0]; const c=document.createElement('canvas'); c.width=t.width;c.height=t.height; const x=c.getContext('2d'); x.drawImage(t.img,0,0); const d=x.getImageData(0,0,t.width,t.height).data; let s=0; for(let i=0;i<d.length;i+=4) s+=d[i]*(i%7+1); return s; })()` });
  await tool('paint_faces', { targets: [{ element: 'limb', color: '#808080' }] });
  await tool('paint_texture', strandArgs);
  const runB = await tool('eval_code', { undo: false, code: `(() => { const t=Texture.all[0]; const c=document.createElement('canvas'); c.width=t.width;c.height=t.height; const x=c.getContext('2d'); x.drawImage(t.img,0,0); const d=x.getImageData(0,0,t.width,t.height).data; let s=0; for(let i=0;i<d.length;i+=4) s+=d[i]*(i%7+1); return s; })()` });
  check('same seed is deterministic', runA.json?.result === runB.json?.result, `${runA.json?.result} vs ${runB.json?.result}`);

  // ── 7. error paths still guard ─────────────────────────────────────────────
  const badSpace = await tool('paint_texture', { ops: [{ type: 'noise', target: { element: 'seg_mid', face: 'north' }, space: 'world', color: '#000' }] });
  check('space "world" rejected on non-gradient ops', badSpace.isError, badSpace.text.slice(0, 140));
  const badStops = await tool('paint_texture', { ops: [{ type: 'gradient', target: { element: 'seg_mid', face: 'north' }, stops: [{ color: '#000' }] }] });
  check('stops without "at" rejected', badStops.isError, badStops.text.slice(0, 140));
  const badFace = await tool('paint_texture', { ops: [{ type: 'rect', target: { element: 'limb', faces: ['sideways'] }, from: [0, 0], to: [1, 1], color: '#000' }] });
  check('unknown face key rejected', badFace.isError, badFace.text.slice(0, 140));

  console.log(failed ? '\nPAINT OPS VERIFY FAILED' : '\nPAINT OPS VERIFY PASSED');
} catch (err) {
  console.error('VERIFY ERROR:', err.message);
  failed = true;
} finally {
  try {
    if (scratchOpen) await tool('close_project', { force: true });
    if (originalTab) await tool('select_project_tab', { uuid: originalTab });
  } catch (err) {
    console.error('cleanup failed:', err.message);
  }
  child.kill();
  process.exit(failed ? 1 : 0);
}
