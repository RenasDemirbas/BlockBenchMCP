// unwrap_mesh: UV-unwrap cubes and meshes into packed islands, with seam
// control, per-part texel density and transfer of already painted texels.
import { register, fail, requireProject } from '../registry';
import { clampInt, describeTexture } from '../util';
import { collectSurfaceElements, surfaceFaces, forEachTexel, worldArea, pixelArea, SurfaceFace } from '../surface';
import { runTextureTemplate } from './textures';
import { paintTarget, commitBitmap } from './layers';

/** Texel density stats (texture px per model unit) over a set of faces. */
export function densityStats(faces: SurfaceFace[]) {
  const per: { label: string; d: number }[] = [];
  for (const f of faces) {
    const wa = worldArea(f.world), pa = Math.abs(pixelArea(f.px));
    if (wa > 1e-4 && pa > 0.25) per.push({ label: `${f.el.name}.${f.key}`, d: Math.sqrt(pa / wa) });
  }
  if (!per.length) return null;
  per.sort((a, b) => a.d - b.d);
  return { min: +per[0].d.toFixed(2), median: +per[Math.floor(per.length / 2)].d.toFixed(2), max: +per[per.length - 1].d.toFixed(2) };
}

register('unwrap_mesh', async (params) => {
  requireProject();
  const ids: string[] = Array.isArray(params.elements) && params.elements.length ? params.elements : ['*'];
  const elements = [...new Set(ids.flatMap((id) => collectSurfaceElements(id, 'unwrap_mesh')))];
  const pixelDensity = clampInt(params.pixel_density ?? 16, 1, 128);

  // ── 1. Seams (their own undo step — the template's undo only covers UVs) ──
  const seamLog: string[] = [];
  if (Array.isArray(params.seams) && params.seams.length) {
    const meshes: any[] = [];
    const jobs = params.seams.map((s: any, i: number) => {
      const mesh = collectSurfaceElements(s.mesh, `seams[${i}]`).find((e: any) => e instanceof Mesh);
      if (!mesh) fail(`seams[${i}]: "${s.mesh}" is not a mesh.`);
      const mode = s.mode ?? 'divide';
      if (!['divide', 'join', 'auto'].includes(mode)) fail(`seams[${i}]: mode must be divide, join or auto.`);
      if (!Array.isArray(s.edges) || !s.edges.length) fail(`seams[${i}]: pass "edges": [[vertexA, vertexB], ...] (vertex keys from get_element).`);
      for (const e of s.edges) {
        if (!Array.isArray(e) || e.length !== 2 || !mesh.vertices[e[0]] || !mesh.vertices[e[1]]) fail(`seams[${i}]: edge ${JSON.stringify(e)} needs two vertex keys of "${mesh.name}".`);
      }
      if (!meshes.includes(mesh)) meshes.push(mesh);
      return { mesh, mode, edges: s.edges };
    });
    Undo.initEdit({ elements: meshes });
    for (const j of jobs) {
      for (const e of j.edges) j.mesh.setSeam(e, j.mode === 'auto' ? null : j.mode);
      seamLog.push(`${j.mesh.name}: ${j.edges.length} edge(s) → ${j.mode}`);
    }
    Undo.finishEdit('MCP: Set UV seams', { elements: meshes });
  }

  // ── 2. Remember painted texels so they can follow their faces ──
  const keepPaint = params.keep_paint !== false;
  const snapshots: { el: any; key: string; px: [number, number][]; data: Uint8ClampedArray; w: number; h: number }[] = [];
  if (keepPaint) {
    const bitmaps = new Map<any, { data: Uint8ClampedArray; w: number; h: number }>();
    for (const f of surfaceFaces(elements)) {
      let bmp = bitmaps.get(f.tex);
      if (!bmp) {
        const cv = f.tex.canvas;
        bmp = { data: cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height };
        bitmaps.set(f.tex, bmp);
      }
      snapshots.push({ el: f.el, key: f.key, px: f.px.map((p) => [p[0], p[1]] as [number, number]), ...bmp });
    }
  }

  // ── 3. Per-part density: temporarily scale the geometry the generator
  //       measures. Its undo entry is UV-only, so the scale never leaks. ──
  const restores: (() => void)[] = [];
  const scaled: string[] = [];
  if (params.density_scale && typeof params.density_scale === 'object') {
    for (const [id, raw] of Object.entries(params.density_scale)) {
      const f = Number(raw);
      if (!(f > 0) || f > 16) fail(`density_scale["${id}"] must be a number between 0 and 16 (2 = twice the texels per unit).`);
      for (const el of collectSurfaceElements(id, `density_scale["${id}"]`)) {
        if (!elements.includes(el)) continue;
        if (el instanceof Mesh) {
          const orig: Record<string, number[]> = {};
          for (const k in el.vertices) { orig[k] = el.vertices[k].slice(); el.vertices[k] = el.vertices[k].map((c: number) => c * f); }
          restores.push(() => { for (const k in orig) el.vertices[k] = orig[k]; });
        } else {
          const from = el.from.slice(), to = el.to.slice();
          const c = from.map((v: number, i: number) => (v + to[i]) / 2);
          el.from.replace(from.map((v: number, i: number) => c[i] + (v - c[i]) * f));
          el.to.replace(to.map((v: number, i: number) => c[i] + (v - c[i]) * f));
          restores.push(() => { el.from.replace(from); el.to.replace(to); });
        }
        scaled.push(`${el.name}×${f}`);
      }
    }
  }

  // ── 4. Generate ──
  unselectAllElements();
  elements.forEach((el: any) => el.markAsSelected?.());
  updateSelection();
  let texture: any;
  try {
    texture = await runTextureTemplate({
      name: params.name || `${Project.name || 'model'}_unwrap`,
      pixelDensity,
      rearrange_uv: true,
      color: params.color,
      power: params.power_of_two !== false,
      padding: params.padding !== false,
      combine_polys: params.combine !== false,
      max_edge_angle: params.seam_angle ?? 36,
      max_island_angle: params.island_angle ?? 45,
    });
  } finally {
    for (const r of restores) r();
    if (restores.length) Canvas.updateView({ elements, element_aspects: { geometry: true, uv: true } });
  }
  Canvas.updateAllUVs();
  Canvas.updateAllFaces();

  // ── 5. Carry the old paint over, face by face ──
  let transferred = 0;
  if (keepPaint && snapshots.length) {
    Undo.initEdit({ textures: [texture], bitmap: true });
    const target = paintTarget(texture);
    const img = target.ctx.getImageData(0, 0, target.canvas.width, target.canvas.height);
    const [ox, oy] = target.offset;
    for (const snap of snapshots) {
      const nf = surfaceFaces([snap.el], { faces: [snap.key] })[0];
      if (!nf || nf.tex !== texture || nf.px.length !== snap.px.length) continue;
      forEachTexel(nf, (x, y, _w, tri, l1, l2, l3) => {
        const a = snap.px[0], b = snap.px[tri], c = snap.px[tri + 1];
        const sx = Math.floor(a[0] * l1 + b[0] * l2 + c[0] * l3);
        const sy = Math.floor(a[1] * l1 + b[1] * l2 + c[1] * l3);
        // Edge texels can land just outside what the old layout painted —
        // borrow the nearest opaque neighbour instead of leaving a hole.
        let si = -1;
        for (let r = 0; r <= 2 && si < 0; r++) {
          for (let dy = -r; dy <= r && si < 0; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const qx = sx + dx, qy = sy + dy;
              if (qx < 0 || qy < 0 || qx >= snap.w || qy >= snap.h) continue;
              const qi = (qy * snap.w + qx) * 4;
              if (snap.data[qi + 3] > 0) { si = qi; break; }
            }
          }
        }
        if (si < 0) return;
        const tx = x - ox, ty = y - oy;
        if (tx < 0 || ty < 0 || tx >= img.width || ty >= img.height) return;
        const di = (ty * img.width + tx) * 4;
        img.data[di] = snap.data[si]; img.data[di + 1] = snap.data[si + 1];
        img.data[di + 2] = snap.data[si + 2]; img.data[di + 3] = snap.data[si + 3];
        transferred++;
      }, 'conservative');
    }
    target.ctx.putImageData(img, 0, 0);
    commitBitmap(texture);
    Undo.finishEdit('MCP: Transfer paint to unwrapped UVs', { textures: [texture], bitmap: true });
  }

  const faces = surfaceFaces(elements, { texture });
  return {
    texture: describeTexture(texture),
    elements: elements.length,
    faces: faces.length,
    seams: seamLog.length ? seamLog : undefined,
    density_scaled: scaled.length ? scaled : undefined,
    texel_density: densityStats(faces),
    transferred_texels: keepPaint ? transferred : undefined,
    note: 'Faces now point at the new texture. Check islands with get_texture / uv action "inspect"; paint with paint_texture targets or bake_texture.',
  };
});
