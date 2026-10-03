// record_build: a build timelapse. While recording, every finished edit
// (undo step) captures a frame from a fixed camera at a fixed scale, so the
// model visibly grows part by part; "stop" writes an animated GIF.
import { register, fail, requireProject } from '../registry';
import { clampInt } from '../util';
import { resolveView, viewBasis, projectBounds, fitFrame, renderableElements } from '../pixelart/camera';
import { renderPixelFrame } from '../pixelart/render';
import { upscaledPreview } from '../pixelart/sheet';

interface Recording {
  yaw: number; pitch: number; size: number; ppu: number;
  frames: Uint8ClampedArray[]; labels: string[];
  lastHash: number; timer: any; listener: any; background: [number, number, number] | null;
}
let rec: Recording | null = null;
const MAX_FRAMES = 600;

function hashFrame(d: Uint8ClampedArray): number {
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 7) h = Math.imul(h ^ d[i], 16777619);
  return h >>> 0;
}

function captureFrame(label: string): boolean {
  if (!rec || !Project) return false;
  const elements = renderableElements();
  const W = rec.size, H = rec.size;
  const out = new Uint8ClampedArray(W * H * 4);
  if (rec.background) for (let i = 0; i < W * H; i++) { out[i * 4] = rec.background[0]; out[i * 4 + 1] = rec.background[1]; out[i * 4 + 2] = rec.background[2]; out[i * 4 + 3] = 255; }
  if (elements.length) {
    const basis = viewBasis(rec.yaw, rec.pitch);
    const bounds = projectBounds(basis, elements);
    // Fixed scale, model origin pinned to the same pixel: the model grows in place.
    const frame = fitFrame(bounds, { width: W, height: H, padding: Math.round(H * 0.05), pixels_per_unit: rec.ppu, scale_snap: 'none', texel_density: 1, anchor: 'origin' });
    const buf = renderPixelFrame(basis, frame, bounds, { supersample: 2, alpha_threshold: 0.5, sampling: 'center', include_reference_models: false });
    for (let i = 0; i < W * H; i++) {
      if (!buf.alpha[i]) continue;
      out[i * 4] = buf.lit[i * 3]; out[i * 4 + 1] = buf.lit[i * 3 + 1]; out[i * 4 + 2] = buf.lit[i * 3 + 2]; out[i * 4 + 3] = 255;
    }
  }
  const h = hashFrame(out);
  if (h === rec.lastHash) return false; // nothing visible changed
  rec.lastHash = h;
  if (rec.frames.length >= MAX_FRAMES) rec.frames.splice(1, 1); // keep the first frame
  rec.frames.push(out);
  rec.labels.push(label);
  return true;
}

/** Drop the edit listener (plugin unload / reload). */
export function stopRecording() {
  if (!rec) return;
  Blockbench.removeListener?.('finish_edit', rec.listener);
  clearTimeout(rec.timer);
  rec = null;
}

register('record_build', async (params) => {
  const action = params.action;
  if (action === 'start') {
    requireProject();
    if (rec) fail('Already recording — call record_build {action: "stop"} first (or "status").');
    const v = resolveView(params.view ?? 'three_quarter', params.yaw, params.pitch);
    const size = clampInt(params.size ?? 256, 64, 1024);
    const heightUnits = Math.max(4, params.height_units ?? 48);
    const bg = params.background ? (window as any).tinycolor(params.background).toRgb() : null;
    rec = {
      yaw: v.yaw, pitch: v.pitch, size, ppu: (size * 0.85) / heightUnits,
      frames: [], labels: [], lastHash: 0, timer: null, listener: null,
      background: bg ? [bg.r, bg.g, bg.b] : null,
    };
    // Each finished undo step = one modeling step. Debounced, because one
    // tool call can finish several edits back to back.
    rec.listener = (data: any) => {
      if (!rec) return;
      clearTimeout(rec.timer);
      const label = data?.message || 'edit';
      rec.timer = setTimeout(() => { try { captureFrame(label); } catch { /* keep recording */ } }, 150);
    };
    Blockbench.on('finish_edit', rec.listener);
    captureFrame('start');
    return { recording: true, view: v.name, size, pixels_per_unit: +rec.ppu.toFixed(3), note: `Every edit now adds a frame (fixed camera, ${heightUnits} units fit the height). Build the model, then call record_build {action: "stop", path}.` };
  }
  if (action === 'frame') {
    if (!rec) fail('Not recording.');
    return { captured: captureFrame(params.label || 'manual'), frames: rec.frames.length };
  }
  if (action === 'status') {
    return rec ? { recording: true, frames: rec.frames.length, last: rec.labels.slice(-5) } : { recording: false };
  }
  if (action === 'stop' || action === 'cancel') {
    if (!rec) fail('Not recording.');
    const r = rec;
    Blockbench.removeListener?.('finish_edit', r.listener);
    clearTimeout(r.timer);
    try { captureFrame('end'); } catch { /* ignore */ }
    rec = null;
    if (action === 'cancel') return { cancelled: true, frames: r.frames.length };
    if (!r.frames.length) fail('No frames were captured.');
    const fps = Math.max(1, Math.min(30, params.fps ?? 6));
    const holdMs = Math.max(0, (params.hold_last ?? 2) * 1000);
    const W = r.size, H = r.size;
    const files: string[] = [];
    const GIFEnc = (window as any).GIFEnc;
    if (params.path) {
      if (!GIFEnc) fail('This Blockbench build does not expose its GIF encoder (GIFEnc).');
      const gif = GIFEnc.GIFEncoder();
      r.frames.forEach((data, i) => {
        const palette = GIFEnc.quantize(data, 256, { format: 'rgba4444', oneBitAlpha: true, clearAlphaThreshold: 127 });
        const index = GIFEnc.applyPalette(data, palette, 'rgba4444');
        const last = i === r.frames.length - 1;
        gif.writeFrame(index, W, H, { palette, delay: last ? 1000 / fps + holdMs : 1000 / fps, transparent: !r.background, transparentIndex: 0, dispose: 2 });
      });
      gif.finish();
      Blockbench.writeFile(params.path, { savetype: 'binary', content: gif.bytes() });
      files.push(params.path);
    }
    // Contact sheet of up to 12 evenly spaced frames as the preview.
    const pick = Math.min(12, r.frames.length);
    const idx = Array.from({ length: pick }, (_, i) => Math.round((i * (r.frames.length - 1)) / Math.max(1, pick - 1)));
    const cols = Math.min(6, pick), rows = Math.ceil(pick / cols);
    const sheet = new Uint8ClampedArray(cols * W * rows * H * 4);
    idx.forEach((fi, n) => {
      const ox = (n % cols) * W, oy = Math.floor(n / cols) * H;
      const f = r.frames[fi];
      for (let y = 0; y < H; y++) sheet.set(f.subarray(y * W * 4, (y + 1) * W * 4), ((oy + y) * cols * W + ox) * 4);
    });
    return {
      frames: r.frames.length,
      fps,
      files: files.length ? files : undefined,
      steps: r.labels.slice(0, 60),
      __image: upscaledPreview(sheet, cols * W, rows * H, 1),
    };
  }
  fail('"action" must be start, frame, status, stop or cancel.');
});
