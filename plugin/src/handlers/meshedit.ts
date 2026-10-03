// edit_mesh: topology operations on meshes. Blockbench's own mesh actions
// (extrude, inset, solidify, loop cut, merge, dissolve, split...) are driven
// through their selection + amend-panel flow; subdivide, bevel and delete are
// implemented here because Blockbench 5.2 has no equivalent.
import { register, fail, requireProject } from '../registry';
import { resolveNode, refreshElements } from '../util';
import { P3, polygonNormal, norm3, dot3, cross3 } from '../surface';

type Sel = { faces: string[]; vertices: string[]; edges: [string, string][] };

const DIRS: Record<string, P3> = {
  up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0],
};

function requireMesh(id: string): any {
  const node = resolveNode(id);
  if (!(node instanceof Mesh)) fail(`"${id}" is a ${node.type}, not a mesh. edit_mesh works on meshes — build one with add_mesh_primitive / add_loft, or convert a cube with run_action "convert_to_mesh".`);
  return node;
}

/** World-space normal of a mesh face. */
function worldNormal(mesh: any, fkey: string): P3 {
  const v = new THREE.Vector3();
  mesh.mesh.updateMatrixWorld(true);
  const pts = mesh.faces[fkey].getSortedVertices().map((k: string) => {
    v.fromArray(mesh.vertices[k]); mesh.mesh.localToWorld(v); return [v.x, v.y, v.z] as P3;
  });
  return polygonNormal(pts);
}

function faceEdges(face: any): [string, string][] {
  const vs: string[] = face.getSortedVertices();
  return vs.map((k, i) => [k, vs[(i + 1) % vs.length]] as [string, string]);
}

/**
 * Resolve a selection spec against a mesh:
 *  "all" | "previous" | {faces, facing, within, vertices, edges, where}
 */
export function resolveSelection(mesh: any, spec: any, previous: Sel | null, label: string): Sel {
  if (spec === 'previous') {
    if (!previous) fail(`${label}: "previous" needs an earlier step in the same call.`);
    return { faces: previous.faces.filter((k) => mesh.faces[k]), vertices: previous.vertices.filter((k) => mesh.vertices[k]), edges: previous.edges };
  }
  if (spec == null || spec === 'all') {
    return { faces: Object.keys(mesh.faces), vertices: Object.keys(mesh.vertices), edges: [] };
  }
  const faces = new Set<string>();
  const vertices = new Set<string>();
  const edges: [string, string][] = [];
  if (Array.isArray(spec.faces)) {
    for (const k of spec.faces) {
      if (mesh.faces[k]) { faces.add(k); continue; }
      if (DIRS[k]) { spec.facing = spec.facing ? [].concat(spec.facing, k) : k; continue; }
      fail(`${label}: mesh "${mesh.name}" has no face "${k}". Use face keys from get_element, a direction name, or "facing".`);
    }
  } else if (spec.faces === 'all') Object.keys(mesh.faces).forEach((k) => faces.add(k));
  if (spec.facing != null) {
    const list: any[] = Array.isArray(spec.facing) && typeof spec.facing[0] !== 'number' ? spec.facing : [spec.facing];
    const within = Math.cos(((spec.within ?? 30) * Math.PI) / 180);
    for (const f of list) {
      const dir: P3 = typeof f === 'string' ? DIRS[f] : norm3(f as P3);
      if (!dir) fail(`${label}: "facing" must be up/down/north/south/east/west or an [x,y,z] vector.`);
      for (const k of Object.keys(mesh.faces)) if (dot3(worldNormal(mesh, k), dir) >= within) faces.add(k);
    }
  }
  if (Array.isArray(spec.vertices)) {
    for (const k of spec.vertices) { if (!mesh.vertices[k]) fail(`${label}: mesh "${mesh.name}" has no vertex "${k}".`); vertices.add(k); }
  }
  if (Array.isArray(spec.edges)) {
    for (const e of spec.edges) {
      if (!Array.isArray(e) || e.length !== 2 || !mesh.vertices[e[0]] || !mesh.vertices[e[1]]) fail(`${label}: edge ${JSON.stringify(e)} needs two vertex keys.`);
      edges.push([e[0], e[1]]); vertices.add(e[0]); vertices.add(e[1]);
    }
  }
  if (spec.where) {
    // {axis: "x"|"y"|"z", min?, max?, space?: "local"|"world"} — vertices in the slab,
    // and faces whose vertices all are.
    const ax = ['x', 'y', 'z'].indexOf(spec.where.axis ?? 'y');
    if (ax < 0) fail(`${label}: where.axis must be x, y or z.`);
    const lo = spec.where.min ?? -Infinity, hi = spec.where.max ?? Infinity;
    const world = spec.where.space === 'world';
    const v = new THREE.Vector3();
    const coord = (k: string) => {
      if (!world) return mesh.vertices[k][ax];
      v.fromArray(mesh.vertices[k]); mesh.mesh.localToWorld(v); return v.toArray()[ax];
    };
    const inside = new Set(Object.keys(mesh.vertices).filter((k) => { const c = coord(k); return c >= lo && c <= hi; }));
    inside.forEach((k) => vertices.add(k));
    for (const k of Object.keys(mesh.faces)) if (mesh.faces[k].vertices.every((vk: string) => inside.has(vk))) faces.add(k);
  }
  for (const k of faces) for (const vk of mesh.faces[k].vertices) vertices.add(vk);
  if (!faces.size && !vertices.size) fail(`${label}: the selection matched nothing on "${mesh.name}".`);
  return { faces: [...faces], vertices: [...vertices], edges };
}

/** Put a selection into Blockbench's edit-mode mesh selection. */
function applySelection(mesh: any, sel: Sel, mode: 'face' | 'edge' | 'vertex') {
  if (!Modes.edit) Modes.options.edit.select();
  unselectAllElements();
  mesh.markAsSelected?.();
  updateSelection();
  try { BarItems.selection_mode.set(mode); } catch { /* older UI */ }
  const edges = sel.edges.length ? sel.edges : (mode === 'edge' ? sel.faces.flatMap((k) => faceEdges(mesh.faces[k])) : []);
  Project.mesh_selection[mesh.uuid] = { vertices: sel.vertices.slice(), edges: edges.map((e) => e.slice()), faces: sel.faces.slice() };
  updateSelection();
}

function currentSelection(mesh: any): Sel {
  const s = Project.mesh_selection[mesh.uuid] || { vertices: [], edges: [], faces: [] };
  return { faces: [...(s.faces || [])], vertices: [...(s.vertices || [])], edges: [...(s.edges || [])] };
}

/**
 * Click a Blockbench mesh action and, if values were given, replay it through
 * its amend panel callback with those values (what the panel's sliders do).
 */
function runAction(id: string, values: Record<string, any> | null, sequence?: Record<string, any>[]) {
  const item = BarItems[id];
  if (!item) fail(`This Blockbench version has no "${id}" action.`);
  let captured: { form: any; cb: any } | null = null;
  const original = Undo.amendEdit;
  Undo.amendEdit = (form: any, cb: any) => { captured = { form, cb }; };
  try {
    item.click();
  } finally {
    Undo.amendEdit = original;
  }
  const steps = sequence || (values ? [values] : []);
  if (!captured || !steps.length) return;
  const c: { form: any; cb: any } = captured;
  const defaults: Record<string, any> = {};
  for (const k in c.form) defaults[k] = c.form[k].value ?? (c.form[k].options ? Object.keys(c.form[k].options)[0] : undefined);
  let result = { ...defaults };
  for (const step of steps) {
    result = { ...result, ...step };
    Undo.undo(null, true);
    c.cb(result, { setValues(v: any) { Object.assign(result, v); }, getResult: () => result });
  }
}

// ───────────────────────────── custom ops ─────────────────────────────

function edgeKey(a: string, b: string) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

/** Split faces 1→4 (quads) / 1→4 (tris), sharing edge midpoints. */
function subdivide(mesh: any, faceKeys: string[], smooth: number): Sel {
  const mids = new Map<string, string>();
  const created: string[] = [];
  const newVerts = new Set<string>();
  const mid = (a: string, b: string) => {
    const k = edgeKey(a, b);
    let m = mids.get(k);
    if (!m) {
      const pa = mesh.vertices[a], pb = mesh.vertices[b];
      m = mesh.addVertices([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2])[0];
      mids.set(k, m!); newVerts.add(m!);
    }
    return m!;
  };
  for (const fk of faceKeys) {
    const face = mesh.faces[fk];
    if (!face) continue;
    const vs: string[] = face.getSortedVertices();
    if (vs.length < 3) continue;
    const uv = (k: string) => face.uv[k] || [0, 0];
    const avgUv = (...ks: string[]) => [ks.reduce((s, k) => s + uv(k)[0], 0) / ks.length, ks.reduce((s, k) => s + uv(k)[1], 0) / ks.length];
    const tex = face.texture;
    const n = vs.length;
    const m = vs.map((k, i) => mid(k, vs[(i + 1) % n]));
    const mUv = vs.map((k, i) => avgUv(k, vs[(i + 1) % n]));
    const parts: { v: string[]; uv: number[][] }[] = [];
    if (n === 4) {
      const c = mesh.addVertices(vs.reduce((acc: number[], k) => acc.map((s, j) => s + mesh.vertices[k][j] / 4), [0, 0, 0]))[0];
      newVerts.add(c);
      const cUv = avgUv(...vs);
      for (let i = 0; i < 4; i++) {
        parts.push({ v: [vs[i], m[i], c, m[(i + 3) % 4]], uv: [uv(vs[i]), mUv[i], cUv, mUv[(i + 3) % 4]] });
      }
    } else {
      for (let i = 0; i < 3; i++) parts.push({ v: [vs[i], m[i], m[(i + 2) % 3]], uv: [uv(vs[i]), mUv[i], mUv[(i + 2) % 3]] });
      parts.push({ v: [m[0], m[1], m[2]], uv: [mUv[0], mUv[1], mUv[2]] });
    }
    delete mesh.faces[fk];
    for (const p of parts) {
      const uvMap: any = {};
      p.v.forEach((k, i) => { uvMap[k] = p.uv[i].slice(); });
      created.push(...mesh.addFaces(new MeshFace(mesh, { vertices: p.v, uv: uvMap, texture: tex })));
    }
  }
  if (smooth > 0) relax(mesh, [...new Set([...newVerts, ...created.flatMap((k) => mesh.faces[k].vertices)])], smooth, 1);
  return { faces: created, vertices: [...newVerts], edges: [] };
}

/** Laplacian smoothing of the given vertices toward their edge neighbours. */
export function relax(mesh: any, vkeys: string[], factor: number, iterations: number) {
  const nb = new Map<string, Set<string>>();
  for (const fk in mesh.faces) {
    const vs: string[] = mesh.faces[fk].getSortedVertices();
    vs.forEach((k, i) => {
      const a = vs[(i + 1) % vs.length], b = vs[(i + vs.length - 1) % vs.length];
      if (!nb.has(k)) nb.set(k, new Set());
      nb.get(k)!.add(a); nb.get(k)!.add(b);
    });
  }
  for (let it = 0; it < iterations; it++) {
    const next: Record<string, number[]> = {};
    for (const k of vkeys) {
      const ns = [...(nb.get(k) || [])];
      if (!ns.length) continue;
      const avg = [0, 1, 2].map((j) => ns.reduce((s, n) => s + mesh.vertices[n][j], 0) / ns.length);
      next[k] = mesh.vertices[k].map((c: number, j: number) => c + (avg[j] - c) * factor);
    }
    for (const k in next) mesh.vertices[k] = next[k];
  }
}

/**
 * Chamfer every sharp edge of a closed mesh: faces shrink away from edges
 * whose dihedral angle exceeds "angle", a strip fills each such edge, and a
 * small polygon caps every corner.
 */
function bevel(mesh: any, offset: number, angle: number): Sel {
  const faces: Record<string, any> = mesh.faces;
  const fkeys = Object.keys(faces).filter((k) => faces[k].vertices.length >= 3);
  const P = (k: string): P3 => mesh.vertices[k] as P3;
  const normal: Record<string, P3> = {};
  for (const k of fkeys) normal[k] = polygonNormal(faces[k].getSortedVertices().map(P));
  const edgeFaces = new Map<string, string[]>();
  for (const k of fkeys) for (const [a, b] of faceEdges(faces[k])) {
    const e = edgeKey(a, b);
    if (!edgeFaces.has(e)) edgeFaces.set(e, []);
    edgeFaces.get(e)!.push(k);
  }
  for (const [e, fs] of edgeFaces) if (fs.length !== 2) fail(`bevel needs a closed mesh (every edge shared by exactly 2 faces); edge ${e.replace('|', '–')} has ${fs.length}. Use it on closed boxy parts (gun bodies, boots, a hat crown).`);
  const cosLimit = Math.cos((angle * Math.PI) / 180);
  const sharp = new Set<string>();
  for (const [e, [f, g]] of edgeFaces) if (dot3(normal[f], normal[g]) < cosLimit) sharp.add(e);
  if (!sharp.size) fail(`No edge of "${mesh.name}" is sharper than ${angle}° — nothing to bevel.`);

  const sub3 = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  // New point per (face, original vertex), merged when they coincide.
  const pointKey = new Map<string, string>();      // `${orig}@${rounded pos}` → new vkey
  const faceVert = new Map<string, string>();      // `${face}|${orig}` → new vkey
  const created: string[] = [];
  for (const fk of fkeys) {
    const vs: string[] = faces[fk].getSortedVertices();
    vs.forEach((v, i) => {
      const p = vs[(i + vs.length - 1) % vs.length], n = vs[(i + 1) % vs.length];
      let pos = P(v).slice() as P3;
      if (sharp.has(edgeKey(p, v))) { const d = norm3(sub3(P(n), P(v))); pos = [pos[0] + d[0] * offset, pos[1] + d[1] * offset, pos[2] + d[2] * offset]; }
      if (sharp.has(edgeKey(v, n))) { const d = norm3(sub3(P(p), P(v))); pos = [pos[0] + d[0] * offset, pos[1] + d[1] * offset, pos[2] + d[2] * offset]; }
      const key = `${v}@${pos.map((c) => c.toFixed(4)).join(',')}`;
      let nk = pointKey.get(key);
      if (!nk) { nk = mesh.addVertices(pos)[0]; pointKey.set(key, nk!); }
      faceVert.set(`${fk}|${v}`, nk!);
    });
  }
  const addFace = (vs: string[], hint: P3, tex: any) => {
    const uniq = vs.filter((k, i) => vs.indexOf(k) === i);
    if (uniq.length < 3) return;
    const n = polygonNormal(uniq.map(P));
    const ordered = dot3(n, hint) < 0 ? uniq.reverse() : uniq;
    created.push(...mesh.addFaces(new MeshFace(mesh, { vertices: ordered, texture: tex })));
  };
  // Shrunk faces keep their key and UVs.
  for (const fk of fkeys) {
    const face = faces[fk];
    const vs: string[] = face.getSortedVertices();
    const uv: any = {};
    const nv = vs.map((v) => { const k = faceVert.get(`${fk}|${v}`)!; uv[k] = (face.uv[v] || [0, 0]).slice(); return k; });
    face.vertices = nv;
    face.uv = uv;
  }
  // Edge strips.
  for (const e of sharp) {
    const [f, g] = edgeFaces.get(e)!;
    const [a, b] = e.split('|');
    const hint = norm3([normal[f][0] + normal[g][0], normal[f][1] + normal[g][1], normal[f][2] + normal[g][2]]);
    addFace([faceVert.get(`${f}|${a}`)!, faceVert.get(`${f}|${b}`)!, faceVert.get(`${g}|${b}`)!, faceVert.get(`${g}|${a}`)!], hint, faces[f].texture);
  }
  // Corner caps.
  const incident = new Map<string, string[]>();
  for (const key of faceVert.keys()) {
    const [fk, v] = key.split('|');
    if (!incident.has(v)) incident.set(v, []);
    incident.get(v)!.push(fk);
  }
  for (const [v, fs] of incident) {
    const pts = [...new Set(fs.map((fk) => faceVert.get(`${fk}|${v}`)!))];
    if (pts.length < 3) continue;
    const vn = norm3(fs.reduce((s: P3, fk) => [s[0] + normal[fk][0], s[1] + normal[fk][1], s[2] + normal[fk][2]] as P3, [0, 0, 0] as P3));
    const c = pts.reduce((s: P3, k) => [s[0] + P(k)[0] / pts.length, s[1] + P(k)[1] / pts.length, s[2] + P(k)[2] / pts.length] as P3, [0, 0, 0] as P3);
    const ref = norm3(sub3(P(pts[0]), c));
    const ref2 = cross3(vn, ref);
    pts.sort((a, b) => {
      const da = sub3(P(a), c), db = sub3(P(b), c);
      return Math.atan2(dot3(da, ref2), dot3(da, ref)) - Math.atan2(dot3(db, ref2), dot3(db, ref));
    });
    const tex = faces[fs[0]].texture;
    if (pts.length <= 4) addFace(pts, vn, tex);
    else {
      const ck = mesh.addVertices(c)[0];
      for (let i = 0; i < pts.length; i++) addFace([pts[i], pts[(i + 1) % pts.length], ck], vn, tex);
    }
  }
  // Drop the original vertices — every face now uses the new ones.
  const used = new Set<string>();
  for (const fk in faces) for (const v of faces[fk].vertices) used.add(v);
  for (const v of Object.keys(mesh.vertices)) if (!used.has(v)) delete mesh.vertices[v];
  return { faces: created, vertices: [], edges: [] };
}

function deleteParts(mesh: any, sel: Sel, mode: string): number {
  let n = 0;
  if (mode === 'vertices') {
    const vs = new Set(sel.vertices);
    for (const fk of Object.keys(mesh.faces)) if (mesh.faces[fk].vertices.some((v: string) => vs.has(v))) { delete mesh.faces[fk]; n++; }
    for (const v of vs) delete mesh.vertices[v];
  } else {
    for (const fk of sel.faces) if (mesh.faces[fk]) { delete mesh.faces[fk]; n++; }
    const used = new Set<string>();
    for (const fk in mesh.faces) for (const v of mesh.faces[fk].vertices) used.add(v);
    for (const v of Object.keys(mesh.vertices)) if (!used.has(v)) delete mesh.vertices[v];
  }
  return n;
}

// ───────────────────────────── handler ─────────────────────────────

const NATIVE: Record<string, { action: string; mode: 'face' | 'edge' | 'vertex' }> = {
  extrude: { action: 'extrude_mesh_selection', mode: 'face' },
  inset: { action: 'inset_mesh_selection', mode: 'face' },
  solidify: { action: 'solidify_mesh_selection', mode: 'face' },
  loop_cut: { action: 'loop_cut', mode: 'face' },
  dissolve_edges: { action: 'dissolve_edges', mode: 'edge' },
  create_face: { action: 'create_face', mode: 'vertex' },
  invert_faces: { action: 'invert_face', mode: 'face' },
  split: { action: 'split_mesh', mode: 'face' },
  merge_vertices: { action: 'merge_vertices', mode: 'vertex' },
};
const CUSTOM = ['subdivide', 'bevel', 'delete', 'merge_meshes'];

register('edit_mesh', (params) => {
  requireProject();
  if (!Format.meshes) fail(`The current format "${Format.id}" has no meshes. Use the "free" format.`);
  const steps: any[] = Array.isArray(params.steps) && params.steps.length ? params.steps : (params.op ? [params] : []);
  if (!steps.length) fail('Pass "steps": [{op, select?, ...}] (or a single {op, ...}). Ops: ' + [...Object.keys(NATIVE), ...CUSTOM].join(', ') + '.');
  let mesh = requireMesh(params.mesh);
  const log: any[] = [];
  let previous: Sel | null = null;

  steps.forEach((step, i) => {
    const label = `steps[${i}] (${step.op})`;
    if (!NATIVE[step.op] && !CUSTOM.includes(step.op)) fail(`${label}: unknown op. Valid: ${[...Object.keys(NATIVE), ...CUSTOM].join(', ')}.`);
    const beforeV = new Set(Object.keys(mesh.vertices));
    const beforeF = new Set(Object.keys(mesh.faces));
    let result: Sel | null = null;
    const entry: any = { op: step.op };

    if (step.op === 'merge_meshes') {
      const others = (step.meshes || []).map((id: string) => requireMesh(id));
      if (!others.length) fail(`${label}: pass "meshes": [names] to merge into "${mesh.name}".`);
      if (!Modes.edit) Modes.options.edit.select();
      unselectAllElements();
      [mesh, ...others].forEach((m: any) => m.markAsSelected());
      updateSelection();
      BarItems.merge_meshes.click();
      mesh = Mesh.selected[0] || mesh;
      entry.merged = others.length;
    } else if (NATIVE[step.op]) {
      const { action, mode } = NATIVE[step.op];
      const sel = resolveSelection(mesh, step.select, previous, label);
      applySelection(mesh, sel, step.op === 'merge_vertices' ? 'vertex' : (step.select?.edges ? 'edge' : mode));
      if (step.op === 'extrude') {
        runAction(action, { extend: step.distance ?? 1, direction_mode: step.direction ?? 'outwards', even_extend: !!step.even });
      } else if (step.op === 'inset') {
        runAction(action, { offset: Math.max(0, Math.min(100, step.amount ?? 50)) });
      } else if (step.op === 'solidify') {
        runAction(action, { thickness: step.thickness ?? 1 });
      } else if (step.op === 'loop_cut') {
        const vals = { cuts: Math.max(1, Math.min(16, Math.round(step.cuts ?? 1))), spacing: step.spacing ?? 'proportional', unit: 'percent', offset: step.position != null ? step.position * 100 : 50 };
        const direction = Math.round(step.direction ?? 0);
        runAction(action, null, direction ? [{ direction }, { ...vals, direction }] : [vals]);
      } else if (step.op === 'merge_vertices') {
        const byDistance = step.distance != null;
        const id = `merge_${byDistance ? 'by_distance' : 'all'}${step.center ? '_in_center' : ''}`;
        const child = BarItems.merge_vertices.children?.find((c: any) => c.id === id);
        if (!child) fail(`${label}: this Blockbench version has no "${id}" merge.`);
        const setting = settings.vertex_merge_distance;
        const old = setting?.value;
        if (byDistance && setting) setting.value = step.distance;
        try { child.click(); } finally { if (byDistance && setting) setting.value = old; }
      } else {
        runAction(action, null);
      }
      if (step.op === 'split') mesh = Mesh.selected.find((m: any) => m !== mesh) || mesh;
      result = currentSelection(mesh);
    } else {
      const sel = resolveSelection(mesh, step.select, previous, label);
      Undo.initEdit({ elements: [mesh], selection: true });
      try {
        if (step.op === 'subdivide') {
          let r: Sel = { faces: sel.faces, vertices: [], edges: [] };
          for (let k = 0; k < Math.max(1, Math.min(3, step.levels ?? 1)); k++) r = subdivide(mesh, r.faces, Math.max(0, Math.min(1, step.smooth ?? 0)));
          result = r;
        } else if (step.op === 'bevel') {
          result = bevel(mesh, Math.max(0.01, step.amount ?? 0.5), step.angle ?? 30);
        } else {
          entry.deleted_faces = deleteParts(mesh, sel, step.what === 'vertices' ? 'vertices' : 'faces');
          result = { faces: [], vertices: [], edges: [] };
        }
      } catch (err) {
        Undo.cancelEdit(true);
        throw err;
      }
      refreshElements([mesh]);
      Undo.finishEdit(`MCP: Mesh ${step.op}`, { elements: [mesh], selection: true });
    }

    const newV = Object.keys(mesh.vertices).filter((k) => !beforeV.has(k));
    const newF = Object.keys(mesh.faces).filter((k) => !beforeF.has(k));
    entry.mesh = mesh.name;
    entry.new_vertices = newV.length;
    entry.new_faces = newF.length;
    entry.faces_total = Object.keys(mesh.faces).length;
    previous = result && (result.faces.length || result.vertices.length) ? result : { faces: newF, vertices: newV, edges: [] };
    entry.selected_after = { faces: previous.faces.slice(0, 40), vertices: previous.vertices.length };
    log.push(entry);
  });

  refreshElements([mesh]);
  return {
    mesh: mesh.name,
    uuid: mesh.uuid,
    vertices: Object.keys(mesh.vertices).length,
    faces: Object.keys(mesh.faces).length,
    steps: log,
    note: 'UVs of new faces are only roughly projected — run unwrap_mesh once the shape is final.',
  };
});
