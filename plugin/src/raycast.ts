// Minimal BVH over world-space triangles for occlusion rays (ambient
// occlusion bakes, visibility tests). Plain arrays, no THREE objects in the
// inner loop.
import { SurfaceFace, P3 } from './surface';

interface Node { min: P3; max: P3; left?: Node; right?: Node; start: number; count: number }

export class TriangleBVH {
  private tris: Float64Array;   // 9 numbers per triangle
  private order: number[];
  private root: Node;

  constructor(faces: SurfaceFace[]) {
    const list: number[] = [];
    for (const f of faces) {
      for (let i = 1; i + 1 < f.world.length; i++) list.push(...f.world[0], ...f.world[i], ...f.world[i + 1]);
    }
    this.tris = new Float64Array(list);
    const n = list.length / 9;
    this.order = Array.from({ length: n }, (_, i) => i);
    this.root = this.build(0, n, 0);
  }

  get size() { return this.tris.length / 9; }

  private centroid(t: number, axis: number) {
    const o = t * 9 + axis;
    return (this.tris[o] + this.tris[o + 3] + this.tris[o + 6]) / 3;
  }

  private build(start: number, count: number, depth: number): Node {
    const min: P3 = [Infinity, Infinity, Infinity], max: P3 = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < start + count; i++) {
      const o = this.order[i] * 9;
      for (let v = 0; v < 9; v += 3) for (let a = 0; a < 3; a++) {
        const c = this.tris[o + v + a];
        if (c < min[a]) min[a] = c;
        if (c > max[a]) max[a] = c;
      }
    }
    const node: Node = { min, max, start, count };
    if (count <= 4 || depth > 32) return node;
    const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const axis = ext[0] > ext[1] ? (ext[0] > ext[2] ? 0 : 2) : (ext[1] > ext[2] ? 1 : 2);
    const slice = this.order.slice(start, start + count).sort((a, b) => this.centroid(a, axis) - this.centroid(b, axis));
    for (let i = 0; i < count; i++) this.order[start + i] = slice[i];
    const half = count >> 1;
    node.left = this.build(start, half, depth + 1);
    node.right = this.build(start + half, count - half, depth + 1);
    node.count = 0;
    return node;
  }

  private static hitsBox(n: Node, o: P3, inv: P3, maxT: number): boolean {
    let t0 = 0, t1 = maxT;
    for (let a = 0; a < 3; a++) {
      let tn = (n.min[a] - o[a]) * inv[a], tf = (n.max[a] - o[a]) * inv[a];
      if (tn > tf) { const t = tn; tn = tf; tf = t; }
      if (tn > t0) t0 = tn;
      if (tf < t1) t1 = tf;
      if (t0 > t1) return false;
    }
    return true;
  }

  /** Möller–Trumbore, both sides; returns t or -1. */
  private hitTri(t: number, o: P3, d: P3): number {
    const k = t * 9, T = this.tris;
    const e1x = T[k + 3] - T[k], e1y = T[k + 4] - T[k + 1], e1z = T[k + 5] - T[k + 2];
    const e2x = T[k + 6] - T[k], e2y = T[k + 7] - T[k + 1], e2z = T[k + 8] - T[k + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return -1;
    const inv = 1 / det;
    const sx = o[0] - T[k], sy = o[1] - T[k + 1], sz = o[2] - T[k + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return -1;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) return -1;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return tt > 1e-6 ? tt : -1;
  }

  /** Does a ray from o along unit d hit anything closer than maxT? */
  occluded(o: P3, d: P3, maxT: number): boolean {
    const inv: P3 = [1 / (d[0] || 1e-12), 1 / (d[1] || 1e-12), 1 / (d[2] || 1e-12)];
    const stack: Node[] = [this.root];
    while (stack.length) {
      const n = stack.pop()!;
      if (!TriangleBVH.hitsBox(n, o, inv, maxT)) continue;
      if (n.left) { stack.push(n.left, n.right!); continue; }
      for (let i = n.start; i < n.start + n.count; i++) {
        const t = this.hitTri(this.order[i], o, d);
        if (t > 0 && t < maxT) return true;
      }
    }
    return false;
  }
}
