// add_loft: build a limb/tube/barrel mesh from cross-section rings along a
// path. Deforming existing meshes (transform_mesh) lives in ./meshdeform.
import { register, fail, requireProject, getHandler } from '../registry';
import { P3, norm3, dot3, cross3, polygonNormal } from '../surface';

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: P3, s: number): P3 => [a[0] * s, a[1] * s, a[2] * s];

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
