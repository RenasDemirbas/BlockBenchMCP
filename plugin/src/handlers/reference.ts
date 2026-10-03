// Matching a reference image. compare_reference renders the model's silhouette
// from a chosen angle, fits it onto the reference's silhouette and scores the
// match (IoU) with per-height-band width differences — numbers an agent can
// act on. project_reference paints the reference image onto the model through
// that same fitted camera: a texture starting point to quantize and repaint.
import { register, fail, requireProject } from '../registry';
import { clampInt } from '../util';
import { resolveView, viewBasis, projectBounds, fitFrame, renderableElements, ViewBasis, FrameSpec, dot } from '../pixelart/camera';
import { renderPixelFrame, PixelBuffers } from '../pixelart/render';
import { collectSurfaceElements, surfaceFaces, forEachTexel, isSurfaceElement, P3 } from '../surface';
import { paintTarget, commitBitmap } from './layers';
import { TriangleBVH } from '../raycast';

interface RGBAImage { data: Uint8ClampedArray; width: number; height: number }
interface Box { x0: number; y0: number; x1: number; y1: number }

async function loadImage(params: any): Promise<RGBAImage> {
  let src: string;
  if (params.image_data) src = String(params.image_data).startsWith('data:') ? params.image_data : `data:image/png;base64,${params.image_data}`;
  else if (params.image) src = 'file:///' + encodeURI(String(params.image).replace(/\\/g, '/')).replace(/#/g, '%23');
  else fail('Pass "image": an absolute path to the reference picture (png/jpg/webp), or "image_data".');
  const img: any = await new Promise((resolve, reject) => {
    const el = new (window as any).Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(`Could not load the reference image "${params.image ?? 'image_data'}". Check the path (absolute, png/jpg/webp).`));
    el.src = src;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
}

/**
 * Foreground mask of the reference: transparency when the image has it,
 * otherwise everything that differs from the background colour (given, or
 * sampled from the four corners).
 */
function referenceMask(img: RGBAImage, params: any): { mask: Uint8Array; box: Box; area: number; background: string } {
  const { data, width: W, height: H } = img;
  const mask = new Uint8Array(W * H);
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4 * 7) if (data[i] < 250) { hasAlpha = true; break; }
  let bg = [255, 255, 255];
  let bgLabel = 'transparent';
  if (!hasAlpha) {
    if (params.background) {
      const c = (window as any).tinycolor(params.background).toRgb();
      bg = [c.r, c.g, c.b];
    } else {
      const corners = [0, W - 1, (H - 1) * W, H * W - 1].map((p) => [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]);
      bg = [0, 1, 2].map((j) => Math.round(corners.reduce((s, c) => s + c[j], 0) / 4));
    }
    bgLabel = `rgb(${bg.join(',')})`;
  }
  const tol = (params.tolerance ?? 40) * 3;
  const box: Box = { x0: W, y0: H, x1: -1, y1: -1 };
  let area = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const fg = hasAlpha ? data[i + 3] >= 128
      : Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > tol;
    if (!fg) continue;
    mask[y * W + x] = 1; area++;
    if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x;
    if (y < box.y0) box.y0 = y; if (y > box.y1) box.y1 = y;
  }
  if (!area) fail('The reference image has no foreground — it looks like plain background. Pass "background" (its colour) and/or a lower "tolerance".');
  return { mask, box, area, background: bgLabel };
}

interface ModelView { buf: PixelBuffers; basis: ViewBasis; frame: FrameSpec; box: Box; area: number; yaw: number; pitch: number; name: string }

function renderModel(params: any, size: number): ModelView {
  const v = resolveView(params.view ?? 'front', params.yaw, params.pitch);
  const basis = viewBasis(v.yaw, v.pitch);
  const elements = renderableElements();
  if (!elements.length) fail('The model has no visible cubes or meshes to compare.');
  const bounds = projectBounds(basis, elements);
  const frame = fitFrame(bounds, { width: size, height: size, padding: 4, scale_snap: 'none', texel_density: 1, anchor: 'center' });
  const buf = renderPixelFrame(basis, frame, bounds, { supersample: 2, alpha_threshold: 0.5, sampling: 'center', include_reference_models: false });
  const box: Box = { x0: size, y0: size, x1: -1, y1: -1 };
  let area = 0;
  for (let y = 0; y < buf.height; y++) for (let x = 0; x < buf.width; x++) {
    if (!buf.alpha[y * buf.width + x]) continue;
    area++;
    if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x;
    if (y < box.y0) box.y0 = y; if (y > box.y1) box.y1 = y;
  }
  if (!area) fail('The model rendered empty from this angle.');
  return { buf, basis, frame, box, area, yaw: v.yaw, pitch: v.pitch, name: v.name };
}

/** Map a model-render pixel to reference-image pixel space (fit by height, centred). */
function fitMapper(model: Box, ref: Box) {
  const s = (ref.y1 - ref.y0 + 1) / (model.y1 - model.y0 + 1);
  const mcx = (model.x0 + model.x1 + 1) / 2, rcx = (ref.x0 + ref.x1 + 1) / 2;
  return { s, map: (x: number, y: number): [number, number] => [rcx + (x - mcx) * s, ref.y0 + (y - model.y0) * s] };
}

register('compare_reference', async (params) => {
  requireProject();
  const img = await loadImage(params);
  const ref = referenceMask(img, params);
  const size = clampInt(params.resolution ?? 384, 64, 1024);
  const model = renderModel(params, size);
  const { s, map } = fitMapper(model.box, ref.box);

  // Compare on a canvas the size of the reference's bounding box (+ margin).
  const margin = Math.round((ref.box.y1 - ref.box.y0) * 0.1);
  const cx0 = Math.max(0, ref.box.x0 - margin), cy0 = Math.max(0, ref.box.y0 - margin);
  const cx1 = Math.min(img.width - 1, ref.box.x1 + margin), cy1 = Math.min(img.height - 1, ref.box.y1 + margin);
  const CW = cx1 - cx0 + 1, CH = cy1 - cy0 + 1;
  // Model mask resampled into reference space (inverse map, nearest).
  const mm = new Uint8Array(CW * CH);
  const mcx = (model.box.x0 + model.box.x1 + 1) / 2, rcx = (ref.box.x0 + ref.box.x1 + 1) / 2;
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const mx = Math.floor(mcx + (cx0 + x + 0.5 - rcx) / s);
    const my = Math.floor(model.box.y0 + (cy0 + y + 0.5 - ref.box.y0) / s);
    if (mx < 0 || my < 0 || mx >= model.buf.width || my >= model.buf.height) continue;
    if (model.buf.alpha[my * model.buf.width + mx]) mm[y * CW + x] = 1;
  }
  let inter = 0, union = 0;
  const bands = clampInt(params.bands ?? 8, 2, 24);
  const bandStats = Array.from({ length: bands }, () => ({ m: 0, r: 0, rows: 0, mMin: Infinity, mMax: -Infinity, rMin: Infinity, rMax: -Infinity }));
  const rH = ref.box.y1 - ref.box.y0 + 1;
  const out = new Uint8ClampedArray(CW * CH * 4);
  for (let y = 0; y < CH; y++) {
    const ry = cy0 + y;
    const band = ry >= ref.box.y0 && ry <= ref.box.y1 ? Math.min(bands - 1, Math.floor(((ry - ref.box.y0) / rH) * bands)) : -1;
    for (let x = 0; x < CW; x++) {
      const a = mm[y * CW + x], b = ref.mask[ry * img.width + cx0 + x];
      if (a && b) inter++;
      if (a || b) union++;
      if (band >= 0) {
        const st = bandStats[band];
        if (a) { st.m++; st.mMin = Math.min(st.mMin, x); st.mMax = Math.max(st.mMax, x); }
        if (b) { st.r++; st.rMin = Math.min(st.rMin, x); st.rMax = Math.max(st.rMax, x); }
      }
      const o = (y * CW + x) * 4;
      // Overlay: both = grey, model only = red, reference only = blue.
      const col = a && b ? [150, 150, 150] : a ? [230, 60, 50] : b ? [60, 120, 230] : [255, 255, 255];
      out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255;
    }
    if (band >= 0) bandStats[band].rows++;
  }
  const iou = union ? inter / union : 0;
  const bandReport = bandStats.map((st, i) => {
    const from = Math.round((i / bands) * 100), to = Math.round(((i + 1) / bands) * 100);
    const mw = st.rows ? st.m / st.rows : 0, rw = st.rows ? st.r / st.rows : 0;
    const mc = isFinite(st.mMin) ? (st.mMin + st.mMax) / 2 : null, rc = isFinite(st.rMin) ? (st.rMin + st.rMax) / 2 : null;
    return {
      band: `${from}-${to}% from top`,
      model_width_px: +mw.toFixed(1),
      reference_width_px: +rw.toFixed(1),
      width_diff_pct: rw ? Math.round(((mw - rw) / rw) * 100) : null,
      center_shift_px: mc != null && rc != null ? Math.round(mc - rc) : null,
    };
  });
  // Model units per reference pixel, so advice can be given in units.
  const unitsPerRefPx = 1 / (model.frame.pixels_per_unit * s);
  const advice: string[] = [];
  for (const b of bandReport) {
    if (b.width_diff_pct == null || Math.abs(b.width_diff_pct) < (params.threshold ?? 12)) continue;
    const du = (b.model_width_px - b.reference_width_px) * unitsPerRefPx;
    advice.push(`${b.band}: model is ${Math.abs(b.width_diff_pct)}% ${b.width_diff_pct > 0 ? 'WIDER' : 'NARROWER'} (~${Math.abs(du).toFixed(1)} units total width) than the reference.`);
  }
  for (const b of bandReport) {
    if (b.center_shift_px != null && Math.abs(b.center_shift_px * unitsPerRefPx) > 1.5) {
      advice.push(`${b.band}: model mass sits ${(Math.abs(b.center_shift_px) * unitsPerRefPx).toFixed(1)} units ${b.center_shift_px > 0 ? 'right' : 'left'} of the reference (image space).`);
    }
  }
  const mAspect = (model.box.x1 - model.box.x0 + 1) / (model.box.y1 - model.box.y0 + 1);
  const rAspect = (ref.box.x1 - ref.box.x0 + 1) / rH;

  // Side-by-side: reference crop | model render (flat colours, fitted) | overlay.
  const panel = document.createElement('canvas');
  panel.width = CW * 3 + 8; panel.height = CH;
  const pctx = panel.getContext('2d');
  pctx.fillStyle = '#ffffff'; pctx.fillRect(0, 0, panel.width, panel.height);
  const refCanvas = document.createElement('canvas');
  refCanvas.width = img.width; refCanvas.height = img.height;
  refCanvas.getContext('2d').putImageData(new (window as any).ImageData(img.data, img.width, img.height), 0, 0);
  pctx.drawImage(refCanvas, cx0, cy0, CW, CH, 0, 0, CW, CH);
  const mc = document.createElement('canvas');
  mc.width = model.buf.width; mc.height = model.buf.height;
  const mctx = mc.getContext('2d');
  const mimg = mctx.createImageData(mc.width, mc.height);
  for (let i = 0; i < mc.width * mc.height; i++) {
    mimg.data[i * 4] = model.buf.lit[i * 3]; mimg.data[i * 4 + 1] = model.buf.lit[i * 3 + 1]; mimg.data[i * 4 + 2] = model.buf.lit[i * 3 + 2];
    mimg.data[i * 4 + 3] = model.buf.alpha[i] ? 255 : 0;
  }
  mctx.putImageData(mimg, 0, 0);
  pctx.imageSmoothingEnabled = false;
  const [dx, dy] = map(0, 0);
  pctx.drawImage(mc, 0, 0, mc.width, mc.height, CW + 4 + (dx - cx0), dy - cy0, mc.width * s, mc.height * s);
  const oc = document.createElement('canvas');
  oc.width = CW; oc.height = CH;
  oc.getContext('2d').putImageData(new (window as any).ImageData(out, CW, CH), 0, 0);
  pctx.drawImage(oc, CW * 2 + 8, 0);
  // Keep the returned image a sensible size.
  let image = panel.toDataURL('image/png');
  if (panel.height > 640) {
    const k = 640 / panel.height;
    const small = document.createElement('canvas');
    small.width = Math.round(panel.width * k); small.height = 640;
    small.getContext('2d').drawImage(panel, 0, 0, small.width, small.height);
    image = small.toDataURL('image/png');
  }

  return {
    view: { name: model.name, yaw: model.yaw, pitch: model.pitch },
    iou: +iou.toFixed(3),
    aspect_ratio: { model: +mAspect.toFixed(3), reference: +rAspect.toFixed(3) },
    reference_background: ref.background,
    bands: bandReport,
    advice: advice.length ? advice : ['Silhouette widths are within the threshold in every band.'],
    legend: 'Image: reference | model (fitted to the reference height, centred) | overlay — grey both, RED model only (too much), BLUE reference only (missing).',
    note: 'Fitting is by height, so the score measures PROPORTIONS, not absolute size. Match the reference\'s camera angle with view/yaw/pitch (front = facing the viewer). IoU above ~0.85 is a close silhouette.',
    __image: image,
  };
});

register('project_reference', async (params) => {
  requireProject();
  const img = await loadImage(params);
  const ref = referenceMask(img, params);
  const size = clampInt(params.resolution ?? 512, 64, 1024);
  const model = renderModel(params, size);
  const { map } = fitMapper(model.box, ref.box);
  const { basis, frame, buf } = model;
  const ppu = frame.pixels_per_unit;
  const toPixel = (p: P3): [number, number] => {
    const u = dot(p, basis.right), v = dot(p, basis.up);
    return [(u - frame.cu) * ppu + frame.width / 2, frame.height / 2 - (v - frame.cv) * ppu];
  };
  const minFacing = params.min_facing ?? 0.15;
  // Occlusion by ray toward the (orthographic) camera — exact, any geometry.
  const bvh = new TriangleBVH(surfaceFaces((Project.elements as any[]).filter((e) => isSurfaceElement(e) && e.visibility !== false)));
  const toCam = basis.dir as P3;
  const ids: string[] = Array.isArray(params.elements) && params.elements.length ? params.elements : ['*'];
  const elements = [...new Set(ids.flatMap((id) => collectSurfaceElements(id, 'project_reference')))];
  const faces = surfaceFaces(elements);
  if (!faces.length) fail('No textured faces to project onto. Unwrap first (unwrap_mesh).');
  const byTex = new Map<any, typeof faces>();
  for (const f of faces) {
    if (dot(f.normal, basis.dir) < minFacing) continue; // facing away from the camera
    if (!byTex.has(f.tex)) byTex.set(f.tex, []);
    byTex.get(f.tex)!.push(f);
  }
  if (!byTex.size) fail('No face points toward this camera. Pick the view the reference was drawn from (view/yaw/pitch).');
  const textures = [...byTex.keys()];
  let painted = 0, hidden = 0, outside = 0;
  const opacity = Math.max(0, Math.min(1, params.opacity ?? 1));
  Undo.initEdit({ textures, bitmap: true });
  try {
    for (const [tex, list] of byTex) {
      const target = paintTarget(tex, params.layer);
      const outImg = target.ctx.getImageData(0, 0, target.canvas.width, target.canvas.height);
      const [ox, oy] = target.offset;
      for (const face of list) {
        forEachTexel(face, (x, y, w) => {
          const [px, py] = toPixel(w);
          const ix = Math.floor(px), iy = Math.floor(py);
          if (ix < 0 || iy < 0 || ix >= buf.width || iy >= buf.height) { outside++; return; }
          // Hidden behind another part from this camera?
          const n = face.normal;
          if (bvh.occluded([w[0] + n[0] * 0.02, w[1] + n[1] * 0.02, w[2] + n[2] * 0.02], toCam, 1e4)) { hidden++; return; }
          const [rx, ry] = map(px, py);
          const rxi = Math.floor(rx), ryi = Math.floor(ry);
          if (rxi < 0 || ryi < 0 || rxi >= img.width || ryi >= img.height || !ref.mask[ryi * img.width + rxi]) { outside++; return; }
          const si = (ryi * img.width + rxi) * 4;
          const tx = x - ox, ty = y - oy;
          if (tx < 0 || ty < 0 || tx >= outImg.width || ty >= outImg.height) return;
          const di = (ty * outImg.width + tx) * 4;
          for (let c = 0; c < 3; c++) outImg.data[di + c] = Math.round(outImg.data[di + c] * (1 - opacity) + img.data[si + c] * opacity);
          outImg.data[di + 3] = 255;
          painted++;
        }, 'conservative');
      }
      target.ctx.putImageData(outImg, 0, 0);
      commitBitmap(tex);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  Undo.finishEdit('MCP: Project reference', { textures, bitmap: true });
  UVEditor.vue?.updateTextureCanvas?.();
  return {
    view: { name: model.name, yaw: model.yaw, pitch: model.pitch },
    painted_texels: painted,
    hidden_texels: hidden,
    outside_reference_texels: outside,
    textures: textures.map((t: any) => t.name),
    layer: params.layer || undefined,
    note: 'Only texels visible from this camera were painted; back and occluded sides keep their colours — project again from "back"/"side" views with matching reference pictures, or paint them by hand. The reference is fitted by silhouette height like compare_reference, so run that first and fix the proportions. Then clean up with palette {action:"quantize"} and bake_texture.',
  };
});
