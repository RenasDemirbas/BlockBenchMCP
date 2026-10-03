// Texel-level view of the model surface: for every textured face (cube or
// mesh), where its pixels sit on the texture AND in the world. Mesh painting,
// texture baking and reference projection are all built on this.
import { fail } from './registry';
import { resolveNode, FACE_KEYS } from './util';

export type P3 = [number, number, number];
export type P2 = [number, number];

export interface SurfaceFace {
  el: any;
  /** Cube face direction or mesh face key. */
  key: string;
  tex: any;
  isMesh: boolean;
  /** Polygon in texture PIXEL coordinates, perimeter order. */
  px: P2[];
  /** Matching world positions. */
  world: P3[];
  /** Mesh vertex keys in the same order (meshes only). */
  vkeys?: string[];
  /** Unit world-space normal. */
  normal: P3;
}

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot3 = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm3 = (a: P3): P3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Newell normal of a (possibly non-planar) polygon. */
export function polygonNormal(pts: P3[]): P3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return norm3([x, y, z]);
}

export function isSurfaceElement(el: any): boolean {
  return el instanceof Cube || el instanceof Mesh;
}

/** Every cube and mesh under a target id ("*" = whole model). */
export function collectSurfaceElements(id: string, context: string): any[] {
  if (id === '*' || id === '**' || id == null) {
    const all = (Project.elements as any[]).filter(isSurfaceElement);
    if (!all.length) fail(`${context}: this model has no cubes or meshes.`);
    return all;
  }
  const node = resolveNode(id);
  const out: any[] = [];
  const walk = (n: any) => {
    if (isSurfaceElement(n)) out.push(n);
    n.children?.forEach(walk);
  };
  walk(node);
  if (!out.length) fail(`${context}: "${node.name}" (${node.type}) contains no cubes or meshes. Pass "*" for the whole model.`);
  return out;
}

function worldOf(el: any, local: P3, v: any): P3 {
  v.set(local[0], local[1], local[2]);
  el.mesh.localToWorld(v);
  return [v.x, v.y, v.z];
}

function texScale(tex: any): [number, number] {
  return [tex.width / tex.getUVWidth(), tex.height / tex.getUVHeight()];
}

/** Cube corner order used by Blockbench's own cube→mesh conversion. */
function cubeFaces(cube: any, fallbackTex: any, keys: string[] | null): SurfaceFace[] {
  const inf = cube.inflate || 0;
  const f = cube.from.map((c: number, i: number) => c - inf - cube.origin[i]);
  const t = cube.to.map((c: number, i: number) => c + inf - cube.origin[i]);
  const corners: P3[] = [
    [t[0], t[1], t[2]], [t[0], t[1], f[2]], [t[0], f[1], t[2]], [t[0], f[1], f[2]],
    [f[0], t[1], t[2]], [f[0], t[1], f[2]], [f[0], f[1], t[2]], [f[0], f[1], f[2]],
  ];
  const ORDER: Record<string, number[]> = {
    east: [1, 0, 3, 2], west: [4, 5, 6, 7], up: [1, 5, 0, 4],
    down: [2, 6, 3, 7], south: [0, 4, 2, 6], north: [5, 1, 7, 3],
  };
  const v = new THREE.Vector3();
  const out: SurfaceFace[] = [];
  for (const key of keys || FACE_KEYS) {
    const face = cube.faces[key];
    if (!face || face.texture === null || face.enabled === false) continue;
    const tex = face.getTexture?.() || fallbackTex;
    if (!tex) continue;
    const [sx, sy] = texScale(tex);
    const pts: P2[] = [[face.uv[0], face.uv[1]], [face.uv[2], face.uv[1]], [face.uv[2], face.uv[3]], [face.uv[0], face.uv[3]]];
    let rot = face.rotation || 0;
    while (rot > 0) { rot -= 90; pts.splice(0, 0, pts.pop()!); }
    const idx = ORDER[key];
    // Perimeter order: listed vertices 0,1,3,2 carry uv points 1,0,3,2.
    const perim = [0, 1, 3, 2];
    const uvOf = [1, 0, 3, 2];
    const world = perim.map((i) => worldOf(cube, corners[idx[i]], v));
    out.push({
      el: cube, key, tex, isMesh: false,
      px: uvOf.map((i) => [pts[i][0] * sx, pts[i][1] * sy] as P2),
      world,
      normal: polygonNormal(world),
    });
  }
  return out;
}

function meshFaces(mesh: any, fallbackTex: any, keys: string[] | null): SurfaceFace[] {
  const v = new THREE.Vector3();
  const out: SurfaceFace[] = [];
  for (const key of keys || Object.keys(mesh.faces)) {
    const face = mesh.faces[key];
    if (!face || face.vertices.length < 3) continue;
    if (face.texture === null) continue;
    const tex = face.getTexture?.() || fallbackTex;
    if (!tex) continue;
    const [sx, sy] = texScale(tex);
    const vkeys: string[] = face.getSortedVertices();
    const world = vkeys.map((k) => worldOf(mesh, mesh.vertices[k] as P3, v));
    out.push({
      el: mesh, key, tex, isMesh: true, vkeys,
      px: vkeys.map((k) => [(face.uv[k]?.[0] ?? 0) * sx, (face.uv[k]?.[1] ?? 0) * sy] as P2),
      world,
      normal: polygonNormal(world),
    });
  }
  return out;
}

/**
 * Textured faces of the given elements. "faces" filters by key: cube
 * direction names apply to cubes, anything else is matched against mesh
 * face keys; "all"/undefined keeps every face.
 */
export function surfaceFaces(elements: any[], opts: { faces?: string[] | 'all'; texture?: any } = {}): SurfaceFace[] {
  (Canvas.scene || (window as any).scene)?.updateMatrixWorld(true);
  const filter = !opts.faces || opts.faces === 'all' ? null : opts.faces;
  const out: SurfaceFace[] = [];
  for (const el of elements) {
    if (!el.mesh) continue;
    if (el instanceof Cube) {
      const keys = filter ? filter.filter((k) => FACE_KEYS.includes(k)) : null;
      if (filter && !keys!.length) continue;
      out.push(...cubeFaces(el, opts.texture, keys));
    } else if (el instanceof Mesh) {
      const keys = filter ? filter.filter((k) => el.faces[k]) : null;
      if (filter && !keys!.length) continue;
      out.push(...meshFaces(el, opts.texture, keys));
    }
  }
  return opts.texture ? out.filter((f) => f.tex === opts.texture) : out;
}

/**
 * Visit every texel whose CENTRE lies inside the face's UV polygon, with the
 * interpolated world position. Each texel is visited once per face.
 */
export function forEachTexel(face: SurfaceFace, cb: (x: number, y: number, world: P3) => void) {
  const n = face.px.length;
  const seen = new Set<number>();
  const W = face.tex.width, H = face.tex.height;
  for (let i = 1; i + 1 < n; i++) {
    const a = face.px[0], b = face.px[i], c = face.px[i + 1];
    const wa = face.world[0], wb = face.world[i], wc = face.world[i + 1];
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / den;
        const l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / den;
        const l3 = 1 - l1 - l2;
        const e = -1e-6;
        if (l1 < e || l2 < e || l3 < e) continue;
        const id = y * W + x;
        if (seen.has(id)) continue;
        seen.add(id);
        cb(x, y, [
          wa[0] * l1 + wb[0] * l2 + wc[0] * l3,
          wa[1] * l1 + wb[1] * l2 + wc[1] * l3,
          wa[2] * l1 + wb[2] * l2 + wc[2] * l3,
        ]);
      }
    }
  }
}

/** Pixel mask of a face: its bounding rect plus 1 bit per covered texel. */
export function faceMask(face: SurfaceFace): { x: number; y: number; w: number; h: number; bits: Uint8Array; count: number } {
  const xs = face.px.map((p) => p[0]), ys = face.px.map((p) => p[1]);
  const x = Math.max(0, Math.floor(Math.min(...xs)));
  const y = Math.max(0, Math.floor(Math.min(...ys)));
  const w = Math.max(1, Math.min(face.tex.width, Math.ceil(Math.max(...xs))) - x);
  const h = Math.max(1, Math.min(face.tex.height, Math.ceil(Math.max(...ys))) - y);
  const bits = new Uint8Array(w * h);
  let count = 0;
  forEachTexel(face, (tx, ty) => {
    const i = (ty - y) * w + (tx - x);
    if (i >= 0 && i < bits.length && !bits[i]) { bits[i] = 1; count++; }
  });
  return { x, y, w, h, bits, count };
}

/** Area of a 3D polygon. */
export function worldArea(pts: P3[]): number {
  let acc: P3 = [0, 0, 0];
  for (let i = 1; i + 1 < pts.length; i++) {
    const c = cross3(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0]));
    acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]];
  }
  return Math.hypot(acc[0], acc[1], acc[2]) / 2;
}

/** Signed area of a 2D polygon. */
export function pixelArea(pts: P2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** World Y extent of every cube and mesh — the default range of world gradients. */
export function modelYRange(): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const f of surfaceFaces((Project.elements as any[]).filter(isSurfaceElement))) {
    for (const p of f.world) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
  }
  return Number.isFinite(lo) && hi > lo ? [lo, hi] : [0, 1];
}

/** Distance from point p to segment ab (2D). */
export function segDist(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
