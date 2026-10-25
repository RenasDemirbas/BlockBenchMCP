// Soft selection for mesh deformers — Blockbench 5.2's proportional editing
// as data: vertices around the selection get a weight 0..1 that fades with
// distance, so a deformation drags its surroundings along instead of tearing
// a hard edge. Distance is straight-line ("linear") or along the mesh edges
// ("connected", so a nearby but unconnected part — the other leg — stays put).
export type V3 = [number, number, number];
export type FalloffCurve = 'linear' | 'smooth' | 'sharp' | 'root' | 'constant';

export interface FalloffSpec {
  radius: number;
  curve?: FalloffCurve;
  distance?: 'linear' | 'connected';
}

export const FALLOFF_CURVES: FalloffCurve[] = ['linear', 'smooth', 'sharp', 'root', 'constant'];

/** Weight at normalized closeness t (1 at the selection, 0 at the radius). */
export function curveWeight(curve: FalloffCurve, t: number): number {
  switch (curve) {
    case 'smooth': return t * t * (3 - 2 * t);
    case 'sharp': return t * t;
    case 'root': return Math.sqrt(t);
    case 'constant': return 1;
    default: return t;
  }
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Straight-line distance from every vertex to the nearest selected one (within radius). */
function linearDistances(vertices: Record<string, V3>, selected: Set<string>, radius: number): Map<string, number> {
  const out = new Map<string, number>();
  const sel = [...selected].map((k) => vertices[k]);
  for (const k in vertices) {
    if (selected.has(k)) continue;
    let d = Infinity;
    for (const p of sel) d = Math.min(d, dist(vertices[k], p));
    if (d <= radius) out.set(k, d);
  }
  return out;
}

/** Shortest path along mesh edges from the selection (multi-source Dijkstra). */
function connectedDistances(vertices: Record<string, V3>, edges: Map<string, Set<string>>, selected: Set<string>, radius: number): Map<string, number> {
  const best = new Map<string, number>();
  const heap: [number, string][] = [];
  const push = (d: number, k: string) => {
    heap.push([d, k]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, string] => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const k of selected) { best.set(k, 0); push(0, k); }
  while (heap.length) {
    const [d, k] = pop();
    if (d > (best.get(k) ?? Infinity)) continue;
    for (const n of edges.get(k) || []) {
      const nd = d + dist(vertices[k], vertices[n]);
      if (nd > radius || nd >= (best.get(n) ?? Infinity)) continue;
      best.set(n, nd);
      push(nd, n);
    }
  }
  for (const k of selected) best.delete(k);
  return best;
}

/** Falloff weight of every unselected vertex inside the radius. */
export function falloffWeights(vertices: Record<string, V3>, edges: Map<string, Set<string>>, selected: string[], spec: FalloffSpec): Map<string, number> {
  const radius = Math.max(0, spec.radius);
  const sel = new Set(selected);
  if (radius <= 0 || !sel.size) return new Map();
  const distances = spec.distance === 'connected'
    ? connectedDistances(vertices, edges, sel, radius)
    : linearDistances(vertices, sel, radius);
  const curve = spec.curve ?? 'smooth';
  const out = new Map<string, number>();
  for (const [k, d] of distances) {
    const w = curveWeight(curve, 1 - d / radius);
    if (w > 1e-4) out.set(k, w);
  }
  return out;
}
