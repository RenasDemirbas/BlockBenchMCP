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
/** Run JS inside Blockbench and return its value. */
async function bb(code) {
  const r = await tool('eval_code', { code, undo: false });
  return r.json?.result ?? r.json ?? r.text;
}
const only = process.argv[2] ? process.argv[2].split(',') : null;
const want = (section) => !only || only.includes(section);

try {
  await sleep(1200);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-lowpoly-tools', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  const status = await tool('get_status', {});
  check('connected to Blockbench', status.json?.connected === true, status.json?.blockbench_version);
  if (status.json?.connected !== true) throw new Error('not connected');

  const scratch = await tool('create_project', { format: 'free', name: 'mcp_lowpoly_probe' });
  check('scratch project created', !scratch.isError, scratch.text.slice(0, 80));

  // ── 0. primitive winding: every face normal points away from the centre ──
  if (want('orient')) {
    for (const shape of ['pyramid', 'cylinder', 'cone', 'sphere', 'torus', 'icosphere', 'octahedron', 'dodecahedron']) {
      await tool('add_mesh_primitive', { shape, sides: 8, name: `o_${shape}`, position: [0, 0, 100] });
      const r = await bb(`(() => { const m = Mesh.all.find(m => m.name === 'o_${shape}'); const vs = Object.values(m.vertices);
        const c = [0,1,2].map(j => vs.reduce((s,v)=>s+v[j],0)/vs.length); let inward = 0, n = 0;
        for (const k in m.faces) { const f = m.faces[k]; const nn = f.getNormal(true); const fc = [0,1,2].map(j => f.vertices.reduce((s,v)=>s+m.vertices[v][j],0)/f.vertices.length);
          const d = fc.map((x,j)=>x-c[j]); if (Math.hypot(...d) < 1e-6) continue;
          ${shape === 'torus' ? `const ring = [fc[0], 0, fc[2]]; const l = Math.hypot(ring[0], ring[2]) || 1; const rc = [ring[0]/l*8, c[1], ring[2]/l*8]; for (let j = 0; j < 3; j++) d[j] = fc[j] - rc[j];` : ''}
          n++; if (nn[0]*d[0]+nn[1]*d[1]+nn[2]*d[2] < 0) inward++; } m.remove(); return [inward, n]; })()`);
      check(`${shape}: normals point outward`, Array.isArray(r) && r[0] === 0, JSON.stringify(r));
    }
  }

  // ── 1. mesh painting ──────────────────────────────────────────────────────
  if (want('paint')) {
    const prim = await tool('add_mesh_primitive', { shape: 'cylinder', sides: 6, diameter: 8, height: 16, name: 'barrel' });
    check('cylinder mesh added', !prim.isError, prim.text.slice(0, 100));
    await tool('add_cubes', { cubes: [{ name: 'box', from: [8, 0, 0], to: [12, 4, 4] }] });
    const tpl = await tool('generate_texture_template', { pixel_density: 16, name: 'probe_tex' });
    check('template generated', !tpl.isError, tpl.text.slice(0, 120));

    const pf = await tool('paint_faces', { targets: [{ element: 'barrel', faces: 'all', color: '#3060c0' }, { element: 'barrel', faces: ['up'], color: '#ff0000' }] });
    check('paint_faces on a mesh (all + direction "up")', !pf.isError && pf.json?.painted >= 7, pf.text.slice(0, 200));

    const up = await bb(`(() => { const m = Mesh.all.find(m => m.name === 'barrel'); const tex = Texture.all[0];
      const fk = Object.keys(m.faces).find(k => { const f = m.faces[k]; return f.vertices.length > 4; } ) || Object.keys(m.faces).find(k => m.faces[k].getNormal(true)[1] > 0.9);
      const f = m.faces[fk]; const vs = f.vertices; const fx = tex.width / tex.getUVWidth();
      let cx = 0, cy = 0; vs.forEach(v => { cx += f.uv[v][0]; cy += f.uv[v][1]; }); cx = Math.floor(cx / vs.length * fx); cy = Math.floor(cy / vs.length * fx);
      const d = tex.canvas.getContext('2d').getImageData(cx, cy, 1, 1).data; return [fk, d[0], d[1], d[2], d[3]]; })()`);
    check('mesh top face centre is red', Array.isArray(up) && up[1] > 200 && up[2] < 40, JSON.stringify(up));

    const grad = await tool('paint_texture', { ops: [{ type: 'gradient', space: 'world', target: { element: 'barrel', faces: ['north', 'south', 'east', 'west'] }, stops: [{ at: 0, color: '#ffffff' }, { at: 1, color: '#000000' }] }] });
    check('world gradient over mesh side faces', !grad.isError && grad.json?.ops_applied >= 4, grad.text.slice(0, 160));

    const rect = await tool('paint_texture', { ops: [{ type: 'rect', target: { element: 'barrel', faces: ['north'] }, from: [0, 0], to: [1, 1], color: '#00ff00' }] });
    check('rect clipped to mesh face polygon', !rect.isError, rect.text.slice(0, 160));
    const red = await bb(`(() => { const m = Mesh.all.find(m => m.name === 'barrel'); const tex = Texture.all[0];
      const fk = Object.keys(m.faces).find(k => m.faces[k].getNormal(true)[1] > 0.9);
      const f = m.faces[fk]; const fx = tex.width / tex.getUVWidth(); let cx = 0, cy = 0; f.vertices.forEach(v => { cx += f.uv[v][0]; cy += f.uv[v][1]; });
      const d = tex.canvas.getContext('2d').getImageData(Math.floor(cx / f.vertices.length * fx), Math.floor(cy / f.vertices.length * fx), 1, 1).data; return [d[0], d[1]]; })()`);
    check('top face untouched by the north-face rect (pixel clipping)', Array.isArray(red) && red[0] > 200 && red[1] < 40, JSON.stringify(red));

    const crop = await tool('get_texture', { element: 'barrel', faces: ['up'] });
    check('get_texture crops to a mesh face', !crop.isError && crop.json?.cropped_to, JSON.stringify(crop.json?.cropped_to)?.slice(0, 160));

    const insp = await tool('inspect_uv', {});
    check('inspect_uv reports meshes + texel density', !insp.isError && insp.json?.mesh_faces > 0 && insp.json?.texel_density, JSON.stringify({ m: insp.json?.mesh_faces, d: insp.json?.texel_density, f: insp.json?.findings?.map((f) => f.type) }));
  }

  // ── 2. unwrap_mesh ────────────────────────────────────────────────────────
  if (want('unwrap')) {
    await tool('delete_elements', { ids: (await bb(`Project.elements.map(e => e.uuid)`)) || [] }).catch(() => {});
    await tool('add_mesh_primitive', { shape: 'cylinder', sides: 8, diameter: 6, height: 20, name: 'arm' });
    await tool('add_mesh_primitive', { shape: 'sphere', sides: 8, diameter: 8, name: 'head', position: [12, 0, 0] });
    await tool('generate_texture_template', { pixel_density: 32, name: 'old_tex' });
    await tool('paint_faces', { targets: [{ element: 'arm', faces: 'all', color: '#2040a0' }, { element: 'arm', faces: ['up'], color: '#ff0000' }, { element: 'head', faces: 'all', color: '#30a030' }] });
    const before = await tool('inspect_uv', {});
    const un = await tool('unwrap_mesh', { pixel_density: 32, density_scale: { head: 2 }, name: 'unwrapped' });
    check('unwrap_mesh runs', !un.isError, un.text.slice(0, 300));
    check('paint transferred', un.json?.transferred_texels > 50, `texels=${un.json?.transferred_texels}`);
    const after = await tool('inspect_uv', {});
    check('no degenerate / overlapping / holed mesh UVs after unwrap', !after.json?.mesh_uv_degenerate && !after.json?.mesh_uv_overlap && !after.json?.transparent_inside_mesh_faces, JSON.stringify(after.json?.findings?.map((f) => f.message.slice(0, 120))));
    const dens = await bb(`(() => { const r = {}; for (const m of Mesh.all) { let pa = 0, wa = 0; const tex = Texture.all.find(t => t.name.startsWith('unwrapped'));
      const fx = tex.width / tex.getUVWidth(); for (const k in m.faces) { const f = m.faces[k]; const vs = f.getSortedVertices(); if (vs.length < 3) continue;
      let s = 0; for (let i = 0; i < vs.length; i++) { const a = f.uv[vs[i]], b = f.uv[vs[(i+1)%vs.length]]; s += a[0]*b[1]-b[0]*a[1]; } pa += Math.abs(s/2)*fx*fx;
      const P = vs.map(v => m.vertices[v]); for (let i = 1; i + 1 < P.length; i++) { const u = P[i].map((c, j) => c - P[0][j]), w = P[i+1].map((c, j) => c - P[0][j]);
      wa += Math.hypot(u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]) / 2; } }
      r[m.name] = wa ? Math.sqrt(pa/wa) : null; } return r; })()`);
    check('head got ~2x texel density', dens && dens.head && dens.arm && dens.head / dens.arm > 1.6 && dens.head / dens.arm < 2.5, JSON.stringify(dens));
    const red = await bb(`(() => { const m = Mesh.all.find(m => m.name === 'arm'); const tex = Texture.all.find(t => t.name.startsWith('unwrapped'));
      const fk = Object.keys(m.faces).find(k => m.faces[k].getNormal(true)[1] > 0.9 && m.faces[k].vertices.length === 3);
      const f = m.faces[fk]; const fx = tex.width / tex.getUVWidth(); let cx = 0, cy = 0; f.vertices.forEach(v => { cx += f.uv[v][0]; cy += f.uv[v][1]; });
      const d = tex.canvas.getContext('2d').getImageData(Math.floor(cx / 3 * fx), Math.floor(cy / 3 * fx), 1, 1).data; return [d[0], d[1], d[2]]; })()`);
    check('red top survives the unwrap', Array.isArray(red) && red[0] > 200 && red[1] < 40, JSON.stringify(red));
    const islands = await bb(`(() => { const m = Mesh.all.find(m => m.name === 'arm'); const seen = new Set(); let n = 0; for (const k in m.faces) { if (seen.has(k)) continue; n++; const isl = m.faces[k].getUVIsland(); isl.forEach(x => seen.add(x)); } return [n, Object.keys(m.faces).length]; })()`);
    check('arm faces were joined into a few islands', Array.isArray(islands) && islands[0] < islands[1] / 2, JSON.stringify(islands));
  }

  // ── 3. edit_mesh ──────────────────────────────────────────────────────────
  if (want('edit')) {
    const maxY = (name) => bb(`Math.max(...Object.values(Mesh.all.find(m => m.name === '${name}').vertices).map(v => v[1]))`);
    await tool('add_mesh_primitive', { shape: 'cylinder', sides: 4, diameter: 8, height: 8, name: 'torso', position: [-20, 0, 0] });
    const chain = await tool('edit_mesh', { mesh: 'torso', steps: [
      { op: 'extrude', select: { facing: 'up' }, distance: 4 },
      { op: 'inset', select: 'previous', amount: 30 },
      { op: 'extrude', select: 'previous', distance: 2 },
    ] });
    check('extrude → inset → extrude chain', !chain.isError && chain.json?.steps?.length === 3, chain.text.slice(0, 400));
    const top = await maxY('torso');
    check('chain raised the top by 6 units', Math.abs(top - 14) < 0.01, `maxY=${top}`);
    const lc = await tool('edit_mesh', { mesh: 'torso', steps: [{ op: 'loop_cut', select: { facing: 'north', within: 60 }, cuts: 2 }] });
    check('loop_cut adds faces', !lc.isError && lc.json?.steps?.[0]?.new_faces > 0, lc.text.slice(0, 300));

    await tool('add_mesh_primitive', { shape: 'cylinder', sides: 4, diameter: 8, height: 6, name: 'gunbody', position: [-40, 0, 0] });
    const bev = await tool('edit_mesh', { mesh: 'gunbody', steps: [{ op: 'bevel', amount: 0.75 }] });
    check('bevel a box → 26 faces', !bev.isError && bev.json?.faces === 26, `faces=${bev.json?.faces} ${bev.isError ? bev.text.slice(0, 200) : ''}`);
    const sub = await tool('edit_mesh', { mesh: 'gunbody', steps: [{ op: 'subdivide', select: { facing: 'up' }, levels: 1 }] });
    check('subdivide splits the top', !sub.isError && sub.json?.faces > 26, `faces=${sub.json?.faces} ${sub.isError ? sub.text.slice(0, 200) : ''}`);
    const del = await tool('edit_mesh', { mesh: 'gunbody', steps: [{ op: 'delete', select: { facing: 'down' } }] });
    check('delete bottom faces', !del.isError && del.json?.faces < sub.json?.faces, `faces=${del.json?.faces}`);
    const sol = await tool('add_mesh_primitive', { shape: 'plane', diameter: 10, name: 'cape', position: [-60, 0, 0] });
    const so = await tool('edit_mesh', { mesh: 'cape', steps: [{ op: 'solidify', thickness: 1 }] });
    check('solidify a plane', !sol.isError && !so.isError && so.json?.faces >= 6, so.text.slice(0, 200));
  }

  // ── 4. add_loft + transform_mesh ──────────────────────────────────────────
  if (want('loft')) {
    const volume = (name) => bb(`(() => { const m = Mesh.all.find(m => m.name === '${name}'); let v = 0;
      for (const k in m.faces) { const vs = m.faces[k].getSortedVertices().map(x => m.vertices[x]);
        for (let i = 1; i + 1 < vs.length; i++) { const [a, b, c] = [vs[0], vs[i], vs[i+1]];
          v += (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0])) / 6; } } return v; })()`);
    const arm = await tool('add_loft', { name: 'arm_l', position: [0, 0, 40], rings: [
      { at: [0, 24, 0], size: [4, 4] }, { at: [0, 16, 1], size: [3.5, 3.5] }, { at: [0, 8, 3], size: [3, 3], twist: 15 }, { at: [0, 4, 3], size: 0 },
    ] });
    check('box loft with a bent path and a pointed tip', !arm.isError && arm.json?.created?.[0]?.faces === 13, arm.text.slice(0, 200));
    const v1 = await volume('arm_l');
    check('loft is closed with outward normals (positive volume)', v1 > 50, `volume=${v1}`);
    const tube = await tool('add_loft', { name: 'barrel_r', profile: 'round', sides: 8, position: [10, 0, 40], rings: [{ at: [0, 0, 0], size: 2 }, { at: [0, 0, -12], size: 2 }] });
    check('round loft along -Z', !tube.isError && tube.json?.created?.[0]?.faces === 8 + 16, tube.text.slice(0, 200));
    const v2 = await volume('barrel_r');
    check('round loft volume ≈ π·r²·h', v2 > 30 && v2 < 40, `volume=${v2}`);

    await tool('add_loft', { name: 'leg', position: [20, 0, 40], rings: [{ at: [0, 0, 0], size: 4 }, { at: [0, 8, 0], size: 4 }, { at: [0, 16, 0], size: 4 }] });
    const tp = await tool('transform_mesh', { mesh: 'leg', ops: [{ type: 'taper', axis: 'y', factor: 2 }] });
    const width = await bb(`(() => { const m = Mesh.all.find(m => m.name === 'leg'); const top = Object.values(m.vertices).filter(v => v[1] > 15.9); return Math.max(...top.map(v => v[0])) - Math.min(...top.map(v => v[0])); })()`);
    check('taper doubles the top width', !tp.isError && Math.abs(width - 8) < 0.01, `width=${width}`);
    const bend = await tool('transform_mesh', { mesh: 'leg', select: { where: { axis: 'y', min: 7.9 } }, ops: [{ type: 'bend', axis: 'y', angle: 90, toward: 'z' }] });
    const tipZ = await bb(`(() => { const m = Mesh.all.find(m => m.name === 'leg'); const vs = Object.values(m.vertices); const top = vs.filter(v => v[2] > 4); return [top.length, Math.max(...vs.map(v => v[2]))]; })()`);
    check('bend curls the upper half toward +Z', !bend.isError && Array.isArray(tipZ) && tipZ[1] > 5, JSON.stringify(tipZ) + bend.text.slice(0, 120));
    const v3 = await volume('leg');
    check('deformed loft still has positive volume', v3 > 0, `volume=${v3}`);
    const jit = await tool('transform_mesh', { mesh: 'leg', ops: [{ type: 'jitter', amount: 0.3, seed: 3 }, { type: 'smooth', factor: 0.3 }] });
    check('jitter + smooth run', !jit.isError, jit.text.slice(0, 120));
  }
} catch (err) {
  check('no exception', false, err.stack || err.message);
} finally {
  try { await tool('close_project', { force: true }); } catch {}
  child.kill();
  console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}
