// bake_texture: hand-painted shading baked straight into the texture, the way
// low-poly/PS1 artists paint it — light direction, ambient occlusion, edge
// highlights and cavities, a world-height gradient and grain. Every pass adds
// "shade steps"; the sum is snapped to whole steps of a hue-shifting
// pixel-art ramp, so shadows drift cool, highlights warm, and the palette
// stays tight.
import { register, fail, requireProject } from '../registry';
import { hash01, resolveTexture } from '../util';
import { collectSurfaceElements, surfaceFaces, forEachTexel, isSurfaceElement, modelYRange, segDist, dot3, norm3, cross3, SurfaceFace, P3, P2 } from '../surface';
import { TriangleBVH } from '../raycast';
import { paintTarget, commitBitmap, findLayer } from './layers';
import { shadeColor, rampOptions, bayerThreshold, RGB } from '../pixelart/color';

type EdgeKind = 'convex' | 'concave' | 'boundary';
interface FaceEdge { a: P2; b: P2; kind: EdgeKind }

/** Classify every edge of every face by the dihedral with its neighbour. */
const faceId = (f: SurfaceFace) => `${f.el.uuid}/${f.key}`;

function classifyEdges(faces: SurfaceFace[], minAngle: number): Map<string, FaceEdge[]> {
  const key = (el: any, p: P3, q: P3) => {
    const s = (v: P3) => v.map((c) => c.toFixed(3)).join(',');
    const [x, y] = [s(p), s(q)].sort();
    return `${el.uuid}|${x}|${y}`;
  };
  const map = new Map<string, { face: SurfaceFace; i: number }[]>();
  for (const f of faces) {
    for (let i = 0; i < f.world.length; i++) {
      const k = key(f.el, f.world[i], f.world[(i + 1) % f.world.length]);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push({ face: f, i });
    }
  }
  const centroid = (f: SurfaceFace): P3 => {
    const c: P3 = [0, 0, 0];
    for (const p of f.world) { c[0] += p[0] / f.world.length; c[1] += p[1] / f.world.length; c[2] += p[2] / f.world.length; }
    return c;
  };
  const cos = Math.cos((minAngle * Math.PI) / 180);
  const out = new Map<string, FaceEdge[]>();
  for (const f of faces) {
    const list: FaceEdge[] = [];
    const c1 = centroid(f);
    for (let i = 0; i < f.world.length; i++) {
      const j = (i + 1) % f.world.length;
      const others = (map.get(key(f.el, f.world[i], f.world[j])) || []).filter((o) => o.face !== f);
      let kind: EdgeKind | null = 'boundary';
      if (others.length) {
        const g = others[0].face;
        if (dot3(f.normal, g.normal) > cos) kind = null; // flat — no line
        else {
          const c2 = centroid(g);
          kind = dot3(f.normal, [c2[0] - c1[0], c2[1] - c1[1], c2[2] - c1[2]]) < 0 ? 'convex' : 'concave';
        }
      }
      if (kind) list.push({ a: f.px[i], b: f.px[j], kind });
    }
    out.set(faceId(f), list);
  }
  return out;
}

/** Cosine-weighted hemisphere directions around n (Fibonacci spiral, rotated per texel). */
function hemisphere(n: P3, count: number, rot: number): P3[] {
  const t = norm3(Math.abs(n[0]) < 0.9 ? cross3(n, [1, 0, 0]) : cross3(n, [0, 1, 0]));
  const b = cross3(n, t);
  const out: P3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let k = 0; k < count; k++) {
    const u = (k + 0.5) / count;
    const r = Math.sqrt(u), phi = k * golden + rot * Math.PI * 2;
    const x = r * Math.cos(phi), y = r * Math.sin(phi), z = Math.sqrt(1 - u);
    out.push([t[0] * x + b[0] * y + n[0] * z, t[1] * x + b[1] * y + n[1] * z, t[2] * x + b[2] * y + n[2] * z]);
  }
  return out;
}

const PASS_TYPES = ['light', 'ao', 'edges', 'gradient', 'noise'];

register('bake_texture', (params) => {
  requireProject();
  const passes: any[] = Array.isArray(params.passes) && params.passes.length ? params.passes : [
    { type: 'light' }, { type: 'ao' }, { type: 'edges' },
  ];
  passes.forEach((p, i) => { if (!PASS_TYPES.includes(p?.type)) fail(`passes[${i}]: type must be one of ${PASS_TYPES.join(', ')}.`); });
  const ids: string[] = Array.isArray(params.elements) && params.elements.length ? params.elements : ['*'];
  const elements = [...new Set(ids.flatMap((id) => collectSurfaceElements(id, 'bake_texture')))];
  const onlyTex = params.texture ? resolveTexture(params.texture) : null;
  const faces = surfaceFaces(elements, onlyTex ? { texture: onlyTex } : {});
  if (!faces.length) fail('No textured faces to bake. Assign a texture (unwrap_mesh / generate_texture_template) first.');

  const ramp = rampOptions(params.ramp);
  const maxShadow = Math.max(1, Math.min(5, params.max_shadow ?? 3));
  const maxLight = Math.max(0, Math.min(4, params.max_highlight ?? 2));
  const dither = params.dither && params.dither !== 'none' ? params.dither : null;
  if (dither && !['bayer2', 'bayer4', 'bayer8'].includes(dither)) fail('dither must be none, bayer2, bayer4 or bayer8.');
  const onlyPainted = params.only_painted !== false;

  // ── Per-pass setup ──
  const aoPass = passes.find((p) => p.type === 'ao');
  const edgePass = passes.find((p) => p.type === 'edges');
  // Every part of the model occludes, not just the baked elements.
  const bvh = aoPass ? new TriangleBVH(surfaceFaces((Project.elements as any[]).filter((e) => isSurfaceElement(e) && e.visibility !== false))) : null;
  const edges = edgePass ? classifyEdges(surfaceFaces((Project.elements as any[]).filter(isSurfaceElement)).filter((f) => elements.includes(f.el)), edgePass.angle ?? 25) : null;
  const yRange = modelYRange();
  let rays = 0;

  // ── Group by texture ──
  const byTex = new Map<any, SurfaceFace[]>();
  for (const f of faces) { if (!byTex.has(f.tex)) byTex.set(f.tex, []); byTex.get(f.tex)!.push(f); }
  const textures = [...byTex.keys()];
  const histogram: Record<string, number> = {};
  const cache = new Map<string, RGB>();
  let baked = 0;
  const start = Date.now();

  Undo.initEdit({ textures, bitmap: true });
  try {
    for (const [tex, list] of byTex) {
      // Shading is computed from FLAT colours: the composite when baking into
      // the base image, or the "source" layer (default: the bottom one) when
      // baking into a separate shading layer — so a re-bake never compounds.
      const target = paintTarget(tex, params.layer);
      let src: { data: Uint8ClampedArray; w: number; h: number; ox: number; oy: number };
      const srcLayer = params.source ? findLayer(tex, params.source)
        : (params.layer && tex.layers_enabled ? tex.layers.find((l: any) => l !== target.layer && l.type !== 'layer_group') : null);
      if (params.source && !srcLayer) fail(`Texture "${tex.name}" has no layer "${params.source}".`);
      if (srcLayer) {
        src = { data: srcLayer.ctx.getImageData(0, 0, srcLayer.canvas.width, srcLayer.canvas.height).data, w: srcLayer.canvas.width, h: srcLayer.canvas.height, ox: srcLayer.offset[0], oy: srcLayer.offset[1] };
      } else {
        const cv = tex.canvas;
        src = { data: cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height, ox: 0, oy: 0 };
      }
      const out = target.ctx.getImageData(0, 0, target.canvas.width, target.canvas.height);
      const [tox, toy] = target.offset;

      for (const face of list) {
        const n = face.normal;
        const faceEdges = edges?.get(faceId(face)) || [];
        forEachTexel(face, (x, y, w) => {
          const sx = x - src.ox, sy = y - src.oy;
          if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) return;
          const si = (sy * src.w + sx) * 4;
          const alpha = src.data[si + 3];
          if (onlyPainted && alpha === 0) return;
          let level = 0;
          for (const p of passes) {
            if (p.type === 'light') {
              const L = norm3(p.direction || [0.5, 1, -0.7]);
              const wrap = p.wrap ?? 0.3;
              const lam = Math.max(0, Math.min(1, (dot3(n, L) + wrap) / (1 + wrap)));
              // Full highlight is reached a little before facing the light
              // head-on, so lit faces sit firmly on a step instead of
              // straddling a band edge.
              const mid = p.midpoint ?? 0.5;
              const full = Math.max(mid + 0.05, p.full ?? 0.85);
              level += lam >= mid ? (p.highlight ?? 1) * Math.min(1, (lam - mid) / (full - mid)) : -(p.shadow ?? 1.5) * (mid - lam) / mid;
            } else if (p.type === 'ao' && bvh) {
              const samples = Math.max(4, Math.min(64, Math.round(p.samples ?? 24)));
              const dist = p.distance ?? 6;
              const o: P3 = [w[0] + n[0] * 0.02, w[1] + n[1] * 0.02, w[2] + n[2] * 0.02];
              let hit = 0;
              for (const d of hemisphere(n, samples, hash01(x, y, 17))) { rays++; if (bvh.occluded(o, d, dist)) hit++; }
              // A 90° corner blocks half the hemisphere — that is full strength.
              level -= (p.strength ?? 1.5) * Math.min(1, (2 * hit) / samples);
            } else if (p.type === 'edges') {
              const width = p.width ?? 1;
              let convex = Infinity, concave = Infinity, boundary = Infinity;
              const c: P2 = [x + 0.5, y + 0.5];
              for (const e of faceEdges) {
                const d = segDist(c, e.a, e.b);
                if (e.kind === 'convex') convex = Math.min(convex, d);
                else if (e.kind === 'concave') concave = Math.min(concave, d);
                else boundary = Math.min(boundary, d);
              }
              if (convex < width) level += p.highlight ?? 1;
              else if (boundary < width) level += p.boundary ?? 1;
              if (concave < width) level -= p.cavity ?? 1;
            } else if (p.type === 'gradient') {
              const [y0, y1] = Array.isArray(p.range) && p.range.length === 2 ? p.range : yRange;
              const t = y1 === y0 ? 0 : Math.max(0, Math.min(1, (w[1] - y0) / (y1 - y0)));
              level += (p.bottom ?? -1) + ((p.top ?? 0) - (p.bottom ?? -1)) * t;
            } else if (p.type === 'noise') {
              const cell = Math.max(1, Math.round(p.scale ?? 1));
              level += (hash01(Math.floor(x / cell), Math.floor(y / cell), p.seed ?? 3) * 2 - 1) * (p.amount ?? 0.3);
            }
          }
          if (dither) level += bayerThreshold(dither, x, y);
          const step = Math.max(-maxShadow, Math.min(maxLight, Math.round(level)));
          histogram[step] = (histogram[step] || 0) + 1;
          const base: RGB = [src.data[si], src.data[si + 1], src.data[si + 2]];
          const ck = `${base[0]},${base[1]},${base[2]},${step}`;
          let rgb = cache.get(ck);
          if (!rgb) { rgb = shadeColor(base, step, ramp); cache.set(ck, rgb); }
          const tx = x - tox, ty = y - toy;
          if (tx < 0 || ty < 0 || tx >= out.width || ty >= out.height) return;
          const di = (ty * out.width + tx) * 4;
          out.data[di] = rgb[0]; out.data[di + 1] = rgb[1]; out.data[di + 2] = rgb[2];
          out.data[di + 3] = alpha || 255;
          baked++;
        }, 'conservative');
      }
      target.ctx.putImageData(out, 0, 0);
      commitBitmap(tex);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  Undo.finishEdit('MCP: Bake texture', { textures, bitmap: true });
  UVEditor.vue?.updateTextureCanvas?.();
  return {
    baked_texels: baked,
    textures: textures.map((t: any) => t.name),
    layer: params.layer || undefined,
    passes: passes.map((p) => p.type),
    shade_steps: histogram,
    ao_rays: rays || undefined,
    occluder_triangles: bvh?.size,
    ms: Date.now() - start,
    note: params.layer ? undefined : 'Baked into the base image — re-baking now would shade already-shaded colours. Bake into a "layer" (e.g. "shading") to keep the flat colours re-bakeable.',
  };
});
