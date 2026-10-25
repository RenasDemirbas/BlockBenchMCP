// The transform_mesh deformers as functions of a single vertex position.
// Each op is measured on the SELECTION (its bounds, pivot and axis span);
// applying it to a point outside the selection — the soft-selection falloff
// around it — continues the deformation sensibly: taper and twist hold their
// end values, a bend carries on straight past its end.
import { fail } from '../registry';
import { hash01 } from '../util';
import { P3, dot3, cross3 } from '../surface';

export const DEFORMERS = ['taper', 'bend', 'twist', 'scale', 'rotate', 'move', 'smooth', 'jitter'];
const AX: Record<string, number> = { x: 0, y: 1, z: 2 };

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** Rotate v around unit axis k by angle (rad) — Rodrigues. */
function rotateAround(v: P3, k: P3, ang: number): P3 {
  const c = Math.cos(ang), s = Math.sin(ang);
  const kv = cross3(k, v), kd = dot3(k, v);
  return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
}

export interface DeformFrame {
  lo: P3;
  hi: P3;
  pivot: P3;
  axis: number;
  others: number[];
  span: number;
  reverse: boolean;
}

/** Measure an op against the selected points (recomputed per op: earlier ops move things). */
export function deformFrame(op: any, points: P3[], label: string): DeformFrame {
  const lo: P3 = [Infinity, Infinity, Infinity], hi: P3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], p[j]); hi[j] = Math.max(hi[j], p[j]); }
  const center: P3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const axis = AX[op.axis ?? 'y'];
  if (axis === undefined) fail(`${label}: axis must be x, y or z.`);
  return {
    lo, hi, axis,
    pivot: Array.isArray(op.pivot) ? op.pivot.map(Number) as P3 : center,
    others: [0, 1, 2].filter((j) => j !== axis),
    span: hi[axis] - lo[axis],
    reverse: op.from === 'max',
  };
}

/** Where along the axis a point is: 0 at "from" (default: the low end), 1 at the other end. */
function along(f: DeformFrame, p: P3): number {
  if (f.span < 1e-9) return 0;
  return (f.reverse ? f.hi[f.axis] - p[f.axis] : p[f.axis] - f.lo[f.axis]) / f.span;
}

/**
 * The deformed position of p. `index` seeds jitter (stable per vertex order).
 * "smooth" is not per-vertex and is handled by the caller.
 */
export function deformPoint(op: any, p: P3, f: DeformFrame, index: number, label: string): P3 {
  const { pivot, axis, others } = f;
  switch (op.type) {
    case 'move': {
      const o = (op.offset || [0, 0, 0]).map(Number) as P3;
      return add(p, o);
    }
    case 'scale': {
      const s: P3 = typeof op.factor === 'number' ? [op.factor, op.factor, op.factor] : (op.factor || [1, 1, 1]).map(Number);
      return [0, 1, 2].map((j) => pivot[j] + (p[j] - pivot[j]) * s[j]) as P3;
    }
    case 'rotate': {
      const r = (op.angles || [0, 0, 0]).map((d: number) => (d * Math.PI) / 180);
      const v = new THREE.Vector3(p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]).applyEuler(new THREE.Euler(r[0], r[1], r[2], 'ZYX'));
      return [v.x + pivot[0], v.y + pivot[1], v.z + pivot[2]];
    }
    case 'taper': {
      // Scale the cross-section linearly along the axis: start → factor.
      const end = op.factor ?? 0.5;
      const endV = Array.isArray(end) ? end.map(Number) : [end, end];
      const start = op.start ?? 1;
      const startV = Array.isArray(start) ? start.map(Number) : [start, start];
      const t = clamp01(along(f, p));
      const out = p.slice() as P3;
      others.forEach((j, n) => { const s = startV[n] + (endV[n] - startV[n]) * t; out[j] = pivot[j] + (p[j] - pivot[j]) * s; });
      return out;
    }
    case 'twist': {
      const total = ((op.angle ?? 45) * Math.PI) / 180;
      const k3: P3 = [0, 0, 0]; k3[axis] = 1;
      const rel = sub(p, pivot); rel[axis] = 0;
      const out = add(rotateAround(rel, k3, total * clamp01(along(f, p))), pivot);
      out[axis] = p[axis];
      return out;
    }
    case 'bend': {
      // Curl the selection along "axis" toward "toward" by "angle" over its length.
      const theta = ((op.angle ?? 45) * Math.PI) / 180;
      const tw = op.toward ?? (axis === 1 ? 'z' : 'y');
      const sign = String(tw).startsWith('-') ? -1 : 1;
      const b = AX[String(tw).replace(/^[-+]/, '')];
      if (b === undefined || b === axis) fail(`${label}: "toward" must be another axis (x, y, z, optionally "-z" etc.).`);
      if (Math.abs(theta) < 1e-6 || f.span < 1e-9) return p;
      const R = f.span / theta;
      const base = f.reverse ? f.hi[axis] : f.lo[axis];
      const dir = f.reverse ? -1 : 1;
      const u = (p[axis] - base) * dir;
      if (u <= 0) return p; // before the bend starts: untouched
      const w = (p[b] - pivot[b]) * sign;
      // Past the end the part continues straight along the bent tangent.
      const arc = Math.min(u, f.span), rest = u - arc;
      const phi = arc / R;
      const out = p.slice() as P3;
      out[axis] = base + dir * ((R - w) * Math.sin(phi) + rest * Math.cos(phi));
      out[b] = pivot[b] + sign * (R - (R - w) * Math.cos(phi) + rest * Math.sin(phi));
      return out;
    }
    case 'jitter': {
      // Seeded hand-made wobble — breaks up the too-perfect primitive look.
      const amt = op.amount ?? 0.3, seed = op.seed ?? 1;
      return [0, 1, 2].map((j) => p[j] + (hash01(index, j, seed) * 2 - 1) * amt) as P3;
    }
    default:
      fail(`${label}: unknown type. Valid: ${DEFORMERS.join(', ')}.`);
  }
}
