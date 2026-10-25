// Pure vertex-weight math: no Blockbench globals, so it reads on its own.
// A weight table maps vertex key → (bone uuid → weight 0..1).
export type V3 = [number, number, number];
export type WeightTable = Map<string, Map<string, number>>;

export interface BoneSegment { id: string; head: V3; tail: V3 }

/** Distance from p to the segment ab. */
export function segmentDistance(p: V3, a: V3, b: V3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

/**
 * Envelope skinning: every vertex follows its nearest bone fully, and blends
 * with the other bones whose segment lies within `blend` units of the
 * nearest one — a soft joint instead of a hard crease. At most `maxBones`
 * influences per vertex, normalized to sum 1.
 */
export function envelopeWeights(vertices: Map<string, V3>, bones: BoneSegment[], blend: number, maxBones: number): WeightTable {
  const out: WeightTable = new Map();
  for (const [vkey, p] of vertices) {
    const dists = bones.map((b) => ({ id: b.id, d: segmentDistance(p, b.head, b.tail) })).sort((x, y) => x.d - y.d);
    if (!dists.length) continue;
    const nearest = dists[0].d;
    const raw = new Map<string, number>();
    for (const { id, d } of dists.slice(0, Math.max(1, maxBones))) {
      const excess = d - nearest;
      if (excess > blend) break;
      // 1 at the nearest bone, falling smoothly to 0 at `blend` units further away.
      const t = blend > 0 ? 1 - excess / blend : 1;
      const w = id === dists[0].id ? 1 : t * t * (3 - 2 * t);
      if (w > 1e-4) raw.set(id, w);
    }
    out.set(vkey, normalizeRow(raw));
  }
  return out;
}

/**
 * Vertices whose weights point at bones far away while another bone runs
 * right past them: weighted bone distance exceeds the nearest bone's by more
 * than `tolerance` units. Unweighted vertices count too. Catches the odd cap
 * or pole vertex a topology-based solver hands to the wrong limb.
 */
export function misassignedVertices(vertices: Map<string, V3>, table: WeightTable, bones: BoneSegment[], tolerance: number): string[] {
  const out: string[] = [];
  for (const [vkey, p] of vertices) {
    const row = table.get(vkey);
    if (!row || !row.size) { out.push(vkey); continue; }
    let nearest = Infinity, assigned = 0, sum = 0;
    for (const b of bones) {
      const d = segmentDistance(p, b.head, b.tail);
      nearest = Math.min(nearest, d);
      const w = row.get(b.id) || 0;
      assigned += w * d;
      sum += w;
    }
    if (sum > 0 && assigned / sum - nearest > tolerance) out.push(vkey);
  }
  return out;
}

export function normalizeRow(row: Map<string, number>): Map<string, number> {
  let sum = 0;
  for (const w of row.values()) sum += w;
  if (sum <= 1e-9) return new Map();
  const out = new Map<string, number>();
  for (const [id, w] of row) out.set(id, round4(w / sum));
  return out;
}

export function normalizeTable(table: WeightTable): WeightTable {
  const out: WeightTable = new Map();
  for (const [vkey, row] of table) out.set(vkey, normalizeRow(row));
  return out;
}

/**
 * Laplacian smoothing of weights over the mesh edges: each vertex moves
 * `factor` of the way toward the average of its neighbours, per iteration.
 * Only `vkeys` change; the result stays normalized.
 */
export function smoothTable(table: WeightTable, neighbours: Map<string, Set<string>>, vkeys: string[], factor: number, iterations: number): WeightTable {
  let current = table;
  for (let it = 0; it < iterations; it++) {
    const next: WeightTable = new Map(current);
    for (const vkey of vkeys) {
      const ns = [...(neighbours.get(vkey) || [])];
      if (!ns.length) continue;
      const avg = new Map<string, number>();
      for (const n of ns) for (const [id, w] of current.get(n) || []) avg.set(id, (avg.get(id) || 0) + w / ns.length);
      const own = current.get(vkey) || new Map();
      const mixed = new Map<string, number>();
      for (const id of new Set([...own.keys(), ...avg.keys()])) {
        const w = (own.get(id) || 0) * (1 - factor) + (avg.get(id) || 0) * factor;
        if (w > 1e-4) mixed.set(id, w);
      }
      next.set(vkey, normalizeRow(mixed));
    }
    current = next;
  }
  return current;
}

export interface WeightStats {
  vertices: number;
  unweighted: string[];
  not_normalized: string[];
  max_influences: number;
  per_bone: Map<string, { vertices: number; sum: number }>;
}

export function tableStats(vkeys: string[], table: WeightTable): WeightStats {
  const stats: WeightStats = { vertices: vkeys.length, unweighted: [], not_normalized: [], max_influences: 0, per_bone: new Map() };
  for (const vkey of vkeys) {
    const row = table.get(vkey);
    if (!row || !row.size) { stats.unweighted.push(vkey); continue; }
    let sum = 0;
    for (const [id, w] of row) {
      sum += w;
      const b = stats.per_bone.get(id) || { vertices: 0, sum: 0 };
      b.vertices++; b.sum += w;
      stats.per_bone.set(id, b);
    }
    stats.max_influences = Math.max(stats.max_influences, row.size);
    if (Math.abs(sum - 1) > 0.01) stats.not_normalized.push(vkey);
  }
  return stats;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
