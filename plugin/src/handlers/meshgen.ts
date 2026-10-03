// add_loft: build a limb/tube/barrel mesh from cross-section rings along a
// path. transform_mesh: deform mesh vertices (taper, bend, twist, scale,
// rotate, move, smooth, jitter) — the shaping half of box modeling.
import { register, fail, requireProject, getHandler } from '../registry';
import { resolveNode, refreshElements, hash01 } from '../util';
import { P3, norm3, dot3, cross3, polygonNormal } from '../surface';
import { resolveSelection, relax } from './meshedit';

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: P3, s: number): P3 => [a[0] * s, a[1] * s, a[2] * s];

/** Rotate v around unit axis k by angle (rad) — Rodrigues. */
function rotateAround(v: P3, k: P3, ang: number): P3 {
  const c = Math.cos(ang), s = Math.sin(ang);
  const kv = cross3(k, v), kd = dot3(k, v);
  return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
}

register('add_loft', (params) => {
  requireProject();
  if (!Format.meshes) fail(`The current format "${Format.id}" has no meshes. Use the "free" format.`);
  const rings: any[] = params.rings;
  if (!Array.isArray(rings) || rings.length < 2) fail('Pass "rings": at least 2 cross-sections [{at: [x,y,z], size: [width, depth] or a number, twist?: deg}, ...] along the limb, in order.');
  const profile = params.profile ?? 'box';
  let shape2d: [number, number][];
  if (Array.isArray(profile)) {
    if (profile.length < 3) fail('A custom "profile" needs at least 3 [x, y] points (in -0.5..0.5, scaled by each ring\'s size).');
    shape2d = profile.map((p: any) => [Number(p[0]), Number(p[1])] as [number, number]);
  } else if (profile === 'box') {
    shape2d = [[0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5], [0.5, -0.5]];
  } else if (profile === 'round') {
    const n = Math.max(3, Math.min(32, Math.round(params.sides ?? 8)));
    shape2d = Array.from({ length: n }, (_, k) => {
      const a = ((k + 0.5) / n) * Math.PI * 2;
      return [Math.cos(a) / 2, Math.sin(a) / 2] as [number, number];
    });
  } else fail('"profile" must be "box", "round" or an array of [x, y] points.');

  const centers: P3[] = rings.map((r, i) => {
    if (!Array.isArray(r.at) || r.at.length !== 3) fail(`rings[${i}] needs "at": [x, y, z].`);
    return r.at.map(Number) as P3;
  });
  for (let i = 1; i < centers.length; i++) {
    if (Math.hypot(...sub(centers[i], centers[i - 1])) < 1e-6) fail(`rings[${i}] sits on the same point as rings[${i - 1}].`);
  }
  // Tangents (central differences), then a rotation-minimising frame so the
  // profile does not spin around a bent limb.
  const tangents: P3[] = centers.map((c, i) => norm3(sub(centers[Math.min(i + 1, centers.length - 1)], centers[Math.max(i - 1, 0)])));
  const hint: P3 = params.side ? norm3(params.side) : (Math.abs(tangents[0][0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]);
  let side = norm3(sub(hint, mul(tangents[0], dot3(hint, tangents[0]))));
  const frames: { s: P3; d: P3 }[] = [];
  tangents.forEach((t, i) => {
    if (i > 0) side = norm3(sub(side, mul(t, dot3(side, t))));
    frames.push({ s: side, d: cross3(t, side) });
  });

  const vertices: Record<string, P3> = {};
  let vi = 0;
  const V = (p: P3) => { const k = `l${vi++}`; vertices[k] = p; return k; };
  const ringKeys: string[][] = rings.map((r, i) => {
    const size = Array.isArray(r.size) ? r.size.map(Number) : [Number(r.size ?? 2), Number(r.size ?? 2)];
    if (!(size[0] >= 0 && size[1] >= 0)) fail(`rings[${i}].size must be non-negative.`);
    const tw = ((r.twist ?? 0) * Math.PI) / 180;
    const off = Array.isArray(r.offset) ? r.offset.map(Number) : [0, 0];
    const { s, d } = frames[i];
    const c = add(centers[i], add(mul(s, off[0]), mul(d, off[1])));
    if (size[0] < 1e-6 && size[1] < 1e-6) { const k = V(c); return shape2d.map(() => k); } // pointed tip
    return shape2d.map(([px, py]) => {
      const x = px * size[0], y = py * size[1];
      const rx = x * Math.cos(tw) - y * Math.sin(tw), ry = x * Math.sin(tw) + y * Math.cos(tw);
      return V(add(c, add(mul(s, rx), mul(d, ry))));
    });
  });

  const faces: { vertices: string[] }[] = [];
  const push = (vs: string[], outward: P3) => {
    const uniq = vs.filter((k, i) => vs.indexOf(k) === i);
    if (uniq.length < 3) return;
    const n = polygonNormal(uniq.map((k) => vertices[k]));
    faces.push({ vertices: dot3(n, outward) < 0 ? uniq.reverse() : uniq });
  };
  const m = shape2d.length;
  for (let i = 0; i + 1 < ringKeys.length; i++) {
    const a = ringKeys[i], b = ringKeys[i + 1];
    const mid = mul(add(centers[i], centers[i + 1]), 0.5);
    for (let k = 0; k < m; k++) {
      const quad = [a[k], a[(k + 1) % m], b[(k + 1) % m], b[k]];
      const fc = quad.reduce((acc: P3, key) => add(acc, mul(vertices[key], 1 / 4)), [0, 0, 0] as P3);
      push(quad, sub(fc, mid));
    }
  }
  const caps = params.caps ?? 'both';
  const cap = (ring: string[], outward: P3) => {
    if (new Set(ring).size < 3) return;
    if (ring.length <= 4) { push(ring, outward); return; }
    const c = V(ring.reduce((acc: P3, k) => add(acc, mul(vertices[k], 1 / ring.length)), [0, 0, 0] as P3));
    for (let k = 0; k < ring.length; k++) push([ring[k], ring[(k + 1) % ring.length], c], outward);
  };
  if (caps === 'both' || caps === 'start') cap(ringKeys[0], mul(tangents[0], -1));
  if (caps === 'both' || caps === 'end') cap(ringKeys[ringKeys.length - 1], tangents[tangents.length - 1]);

  const handler = getHandler('add_meshes')!;
  return handler({
    meshes: [{
      name: params.name || 'loft',
      parent: params.parent,
      position: params.position,
      rotation: params.rotation,
      texture: params.texture,
      vertices,
      faces,
    }],
  });
});

// ───────────────────────────── transform_mesh ─────────────────────────────

const AX: Record<string, number> = { x: 0, y: 1, z: 2 };

register('transform_mesh', (params) => {
  requireProject();
  const ids: string[] = Array.isArray(params.meshes) ? params.meshes : [params.mesh];
  if (!ids.length || ids[0] == null) fail('Pass "mesh" (or "meshes": [...]).');
  const meshes = ids.map((id) => {
    const n = resolveNode(id);
    if (!(n instanceof Mesh)) fail(`"${id}" is a ${n.type}, not a mesh.`);
    return n;
  });
  const ops: any[] = Array.isArray(params.ops) ? params.ops : [];
  if (!ops.length) fail('Pass "ops": [{type: taper|bend|twist|scale|rotate|move|smooth|jitter, ...}].');

  Undo.initEdit({ elements: meshes });
  const report: any[] = [];
  try {
    for (const mesh of meshes) {
      const sel = resolveSelection(mesh, params.select, null, 'select');
      const keys = sel.vertices.length ? sel.vertices : Object.keys(mesh.vertices);
      const get = (k: string) => mesh.vertices[k] as P3;
      ops.forEach((op, i) => {
        const label = `ops[${i}] (${op.type})`;
        // Selection bounds are recomputed per op: earlier ops move things.
        const lo: P3 = [Infinity, Infinity, Infinity], hi: P3 = [-Infinity, -Infinity, -Infinity];
        for (const k of keys) for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], get(k)[j]); hi[j] = Math.max(hi[j], get(k)[j]); }
        const center: P3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        const pivot: P3 = Array.isArray(op.pivot) ? op.pivot.map(Number) as P3 : center;
        const axis = AX[op.axis ?? 'y'];
        if (axis === undefined) fail(`${label}: axis must be x, y or z.`);
        const others = [0, 1, 2].filter((j) => j !== axis);
        const span = hi[axis] - lo[axis];
        // Where along the axis a vertex is, 0 at "from" (default: the low end).
        const reverse = op.from === 'max';
        const tOf = (p: P3) => span < 1e-9 ? 0 : (reverse ? (hi[axis] - p[axis]) : (p[axis] - lo[axis])) / span;

        switch (op.type) {
          case 'move': {
            const o = (op.offset || [0, 0, 0]).map(Number);
            for (const k of keys) mesh.vertices[k] = add(get(k), o as P3);
            break;
          }
          case 'scale': {
            const f: P3 = typeof op.factor === 'number' ? [op.factor, op.factor, op.factor] : (op.factor || [1, 1, 1]).map(Number);
            for (const k of keys) { const p = get(k); mesh.vertices[k] = [0, 1, 2].map((j) => pivot[j] + (p[j] - pivot[j]) * f[j]) as P3; }
            break;
          }
          case 'rotate': {
            const r = (op.angles || [0, 0, 0]).map((d: number) => (d * Math.PI) / 180);
            const e = new THREE.Euler(r[0], r[1], r[2], 'ZYX');
            const v = new THREE.Vector3();
            for (const k of keys) {
              const p = get(k);
              v.set(p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]).applyEuler(e);
              mesh.vertices[k] = [v.x + pivot[0], v.y + pivot[1], v.z + pivot[2]];
            }
            break;
          }
          case 'taper': {
            // Scale the cross-section linearly along the axis: 1 at the start → factor at the end.
            const end = op.factor ?? 0.5;
            const endV = Array.isArray(end) ? end.map(Number) : [end, end];
            const start = op.start ?? 1;
            const startV = Array.isArray(start) ? start.map(Number) : [start, start];
            for (const k of keys) {
              const p = get(k).slice() as P3;
              const t = tOf(p);
              others.forEach((j, n) => { const s = startV[n] + (endV[n] - startV[n]) * t; p[j] = pivot[j] + (p[j] - pivot[j]) * s; });
              mesh.vertices[k] = p;
            }
            break;
          }
          case 'twist': {
            const total = ((op.angle ?? 45) * Math.PI) / 180;
            const k3: P3 = [0, 0, 0]; k3[axis] = 1;
            for (const k of keys) {
              const p = get(k);
              const rel = sub(p, pivot); rel[axis] = 0;
              const r = rotateAround(rel, k3, total * tOf(p));
              const out = add(r, pivot); out[axis] = p[axis];
              mesh.vertices[k] = out;
            }
            break;
          }
          case 'bend': {
            // Curl the selection along "axis" toward "toward" by "angle" over its length.
            const theta = ((op.angle ?? 45) * Math.PI) / 180;
            const tw = op.toward ?? (axis === 1 ? 'z' : 'y');
            const sign = String(tw).startsWith('-') ? -1 : 1;
            const b = AX[String(tw).replace(/^[-+]/, '')];
            if (b === undefined || b === axis) fail(`${label}: "toward" must be another axis (x, y, z, optionally "-z" etc.).`);
            if (Math.abs(theta) < 1e-6 || span < 1e-9) break;
            const R = span / theta;
            const base = reverse ? hi[axis] : lo[axis];
            const dir = reverse ? -1 : 1;
            for (const k of keys) {
              const p = get(k).slice() as P3;
              const u = (p[axis] - base) * dir;
              const w = (p[b] - pivot[b]) * sign;
              const phi = u / R;
              p[axis] = base + dir * (R - w) * Math.sin(phi);
              p[b] = pivot[b] + sign * (R - (R - w) * Math.cos(phi));
              mesh.vertices[k] = p;
            }
            break;
          }
          case 'smooth':
            relax(mesh, keys, Math.max(0, Math.min(1, op.factor ?? 0.5)), Math.max(1, Math.min(20, Math.round(op.iterations ?? 1))));
            break;
          case 'jitter': {
            // Seeded hand-made wobble — breaks up the too-perfect primitive look.
            const amt = op.amount ?? 0.3, seed = op.seed ?? 1;
            keys.forEach((k, n) => {
              const p = get(k);
              mesh.vertices[k] = [0, 1, 2].map((j) => p[j] + (hash01(n, j, seed) * 2 - 1) * amt) as P3;
            });
            break;
          }
          default:
            fail(`${label}: unknown type. Valid: taper, bend, twist, scale, rotate, move, smooth, jitter.`);
        }
      });
      report.push({ mesh: mesh.name, vertices_moved: keys.length });
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  refreshElements(meshes, { geometry: true, uv: true, faces: true });
  Undo.finishEdit('MCP: Transform mesh', { elements: meshes });
  return { transformed: report, ops: ops.map((o) => o.type) };
});
