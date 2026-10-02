// Pixel-art export: render the model from game-style views (side, 3/4
// top-down, 2:1 isometric, 4/8-direction sets) at sprite sizes (16–256 px)
// as GENUINE pixel art — texel-aligned orthographic frames, mode-filtered
// supersampling (no blended colours), cel shading with hue-shifted ramps,
// selective outlines, depth-based inner lines, palette snapping — and pack
// animation frames into sprite sheets with Aseprite-compatible JSON.
import { register, fail, requireProject } from '../registry';
import { resolveAnimation, clampInt } from '../util';
import { PLUGIN_VERSION } from '../socket';
import {
  resolveView, buildDirections, viewBasis, projectBounds, fitFrame, renderableElements, textureTexelDensity,
  viewPresetNames, ViewBounds, FrameSpec, DirectionSpec, ViewBasis, VIEW_PRESETS, V3,
} from '../pixelart/camera';
import { renderPixelFrame, RenderPassOptions } from '../pixelart/render';
import { processFrame, StyleOptions, lightInViewSpace, collectTextureColors, flipHorizontal, flipNormalMap, ProcessedFrame } from '../pixelart/process';
import { packSheet, rgbaToPngDataUrl, upscaledPreview, previewScaleFor, writePng, writeText, asepriteJson, SheetFrame, SheetLayoutOptions } from '../pixelart/sheet';
import { PALETTES, parseHex, rampOptions, paletteNames, RGB, toHex } from '../pixelart/color';

// ───────────────────────────── option parsing ─────────────────────────────

const STYLE_PRESETS: Record<string, { shading: StyleOptions['shading']; outline: StyleOptions['outline']; inner_lines: string }> = {
  outlined: { shading: 'toon', outline: 'outer', inner_lines: 'depth+parts' },
  clean: { shading: 'toon', outline: 'none', inner_lines: 'none' },
  minecraft: { shading: 'blockbench', outline: 'none', inner_lines: 'none' },
  flat: { shading: 'flat', outline: 'none', inner_lines: 'none' },
};

const INNER_LINE_FLAGS = ['depth', 'normal', 'parts'] as const;

/** "depth", "parts", "depth+parts", "depth+normal", "all", "none" → flag set. */
function parseInnerLines(value: any, fallback: string): StyleOptions['inner_lines'] {
  const text = String(value ?? fallback).toLowerCase().trim();
  const flags = { depth: false, normal: false, parts: false };
  if (text === 'none' || text === '') return flags;
  if (text === 'all') return { depth: true, normal: true, parts: true };
  for (const part of text.split(/[+,\s]+/)) {
    if (!(INNER_LINE_FLAGS as readonly string[]).includes(part)) {
      fail(`"inner_lines" must combine ${INNER_LINE_FLAGS.join(', ')} with "+" (e.g. "depth+parts"), or be "all"/"none" — got ${JSON.stringify(value)}.`);
    }
    (flags as any)[part] = true;
  }
  return flags;
}

function innerLinesLabel(flags: StyleOptions['inner_lines']): string {
  const on = INNER_LINE_FLAGS.filter((f) => flags[f]);
  return on.length ? on.join('+') : 'none';
}

function parseSize(size: any): [number, number] {
  if (size == null) return [32, 32];
  if (typeof size === 'number') return [clampInt(size, 8, 512), clampInt(size, 8, 512)];
  if (Array.isArray(size) && size.length === 2) return [clampInt(size[0], 8, 512), clampInt(size[1], 8, 512)];
  fail(`"size" must be a number (16, 32, 64, 128 …) or [width, height], got ${JSON.stringify(size)}.`);
}

function parseColor(value: any, what: string): RGB | undefined {
  if (value == null) return undefined;
  const rgb = parseHex(String(value));
  if (!rgb) fail(`${what} must be a hex colour like "#1a1c2c", got ${JSON.stringify(value)}.`);
  return rgb;
}

function oneOf<T extends string>(value: any, valid: readonly T[], fallback: T, what: string): T {
  if (value == null) return fallback;
  if (!valid.includes(value)) fail(`${what} must be one of ${valid.join(', ')}, got ${JSON.stringify(value)}.`);
  return value;
}

function parsePalette(value: any): StyleOptions['palette'] {
  if (value == null) return 'source';
  if (Array.isArray(value)) {
    const colors = value.map((v: any) => parseColor(v, 'palette entry')!).filter(Boolean);
    if (!colors.length) fail('"palette" array is empty.');
    return colors;
  }
  const s = String(value).toLowerCase();
  if (s === 'source' || s === 'auto' || s === 'none') return s;
  const named = PALETTES[s];
  if (!named) fail(`Unknown palette "${value}". Use "source" (the model's own texture colours + shade ramps, default), "auto" (median cut to max_colors), "none", a built-in name (${paletteNames().join(', ')}) or an array of hex colours.`);
  return named.colors.map((h) => parseHex(h)!);
}

function parseStyle(params: any, size: [number, number], ppu: number): StyleOptions {
  const presetName = oneOf(params.style, ['outlined', 'clean', 'minecraft', 'flat'] as const, 'outlined', '"style"');
  const preset = STYLE_PRESETS[presetName];
  const minSide = Math.min(size[0], size[1]);
  const shading = oneOf(params.shading, ['toon', 'blockbench', 'flat'] as const, preset.shading, '"shading"');
  const defaultLevels = minSide <= 16 ? 2 : minSide <= 48 ? 3 : 4;
  const light: V3 = Array.isArray(params.light) && params.light.length === 3 ? [Number(params.light[0]), Number(params.light[1]), Number(params.light[2])] : [-0.35, 0.75, 0.45];
  if (light.some((v) => !isFinite(v)) || Math.hypot(light[0], light[1], light[2]) < 1e-6) fail('"light" must be a non-zero [x, y, z] direction (x = image right, y = up, z = toward the camera).');
  const outlineColor = params.outline_color == null || params.outline_color === 'auto' ? 'auto' : parseColor(params.outline_color, '"outline_color"')!;
  const lineColor = params.line_color == null || params.line_color === 'auto' ? 'auto' : parseColor(params.line_color, '"line_color"')!;
  const palette = parsePalette(params.palette);
  const defaultMaxColors = minSide <= 16 ? 12 : minSide <= 32 ? 24 : minSide <= 64 ? 40 : 64;
  const dither = oneOf(params.dither, ['none', 'bayer2', 'bayer4', 'bayer8'] as const, 'none', '"dither"');
  return {
    shading,
    shade_levels: clampInt(params.shade_levels ?? defaultLevels, 1, 5),
    light,
    ramp: rampOptions(params.ramp),
    outline: oneOf(params.outline, ['none', 'outer', 'inner'] as const, preset.outline, '"outline"'),
    outline_color: outlineColor,
    outline_connectivity: params.outline_connectivity === 8 ? 8 : 4,
    inner_lines: parseInnerLines(params.inner_lines, preset.inner_lines),
    line_depth_threshold: typeof params.line_depth_threshold === 'number' ? Math.max(0.01, params.line_depth_threshold) : Math.max(1.5, 2.5 / ppu),
    line_side: oneOf(params.line_side, ['near', 'far'] as const, 'near', '"line_side"'),
    line_color: lineColor,
    palette,
    max_colors: clampInt(params.max_colors ?? defaultMaxColors, 2, 256),
    dither,
    dither_strength: typeof params.dither_strength === 'number' ? Math.max(0, Math.min(1, params.dither_strength)) : 0.5,
    cleanup: oneOf(params.cleanup, ['none', 'specks', 'despeckle'] as const, 'specks', '"cleanup"'),
    pixel_perfect: params.pixel_perfect !== false,
    alpha_bleed: params.alpha_bleed !== false,
    background: parseColor(params.background, '"background"'),
  };
}

function describeStyle(style: StyleOptions): any {
  return {
    shading: style.shading,
    shade_levels: style.shading === 'toon' ? style.shade_levels : undefined,
    light: style.shading === 'toon' ? style.light : undefined,
    outline: style.outline,
    outline_color: style.outline === 'none' ? undefined : (style.outline_color === 'auto' ? 'auto (selective: darker, cooler shade of the neighbouring colour)' : toHex(style.outline_color)),
    inner_lines: innerLinesLabel(style.inner_lines),
    line_depth_threshold: style.inner_lines.depth ? Math.round(style.line_depth_threshold * 100) / 100 : undefined,
    palette: Array.isArray(style.palette) ? `${style.palette.length} colours` : style.palette,
    max_colors: style.palette === 'auto' ? style.max_colors : undefined,
    dither: style.dither === 'none' ? undefined : `${style.dither} @ ${style.dither_strength}`,
    cleanup: style.cleanup,
    pixel_perfect: style.pixel_perfect,
  };
}

function supersampleFor(size: [number, number], requested: any): number {
  const longest = Math.max(size[0], size[1]);
  let s = typeof requested === 'number' ? clampInt(requested, 1, 8) : longest <= 64 ? 4 : longest <= 128 ? 3 : 2;
  while (longest * s > 2048 && s > 1) s--;
  return s;
}

// ───────────────────────────── animation sampling ─────────────────────────────

interface Sample { tag: string; time: number; duration_ms: number; animation: any | null; rest?: boolean }
interface AnimationPlan { name: string; fps: number; loop: string; length: number; frames: number }

function ensureAnimateMode() {
  if (Mode.selected?.id !== 'animate' && Modes.options?.animate?.condition?.() !== false) {
    try { Modes.options.animate.select(); } catch { /* ignore */ }
  }
}

function planSamples(params: any): { samples: Sample[]; animations: AnimationPlan[]; fps: number } {
  const names: string[] = Array.isArray(params.animations) ? params.animations : (params.animation ? [params.animation] : []);
  const fps = Math.max(1, Math.min(60, Number(params.fps) || 12));
  if (!names.length) {
    const time = typeof params.time === 'number' ? params.time : undefined;
    let anim: any = null;
    if (time !== undefined && Format.animation_mode) {
      anim = Animation.selected || null;
      if (!anim) fail('"time" needs an animation: pass "animation" (name/uuid) as well.');
    }
    const pose = oneOf(params.pose, ['rest', 'current'] as const, 'rest', '"pose"');
    return { samples: [{ tag: anim ? anim.name : 'static', time: time ?? 0, duration_ms: Math.round(1000 / fps), animation: anim, rest: !anim && pose === 'rest' }], animations: [], fps };
  }
  if (!Format.animation_mode) fail(`Format "${Format.id}" has no animations — drop "animation" to render the static model.`);
  const samples: Sample[] = [];
  const plans: AnimationPlan[] = [];
  for (const name of names) {
    const anim = resolveAnimation(name);
    const length = anim.length || anim.getMaxLength?.() || 0;
    let times: number[];
    if (Array.isArray(params.times) && params.times.length) {
      if (names.length > 1) fail('"times" can only be used with a single animation.');
      times = params.times.map((t: any) => Math.max(0, Number(t) || 0));
    } else {
      let count: number;
      if (typeof params.frames === 'number') {
        count = clampInt(params.frames, 1, 256);
        times = Array.from({ length: count }, (_, i) => (count === 1 ? 0 : (i / (anim.loop === 'loop' ? count : Math.max(1, count - 1))) * length));
      } else {
        const loop = anim.loop === 'loop';
        count = Math.max(1, Math.round(length * fps) + (loop ? 0 : 1));
        count = Math.min(count, 256);
        times = Array.from({ length: count }, (_, i) => i / fps);
      }
    }
    plans.push({ name: anim.name, fps, loop: anim.loop, length: Math.round(length * 1000) / 1000, frames: times.length });
    for (const t of times) samples.push({ tag: anim.name, time: Math.round(t * 100000) / 100000, duration_ms: Math.round(1000 / fps), animation: anim });
  }
  return { samples, animations: plans, fps };
}

function applyPose(sample: Sample) {
  if (!sample.animation) {
    // A static sprite means the REST pose — not whatever frame the timeline
    // happens to sit on ("pose": "current" keeps the viewport pose).
    if (sample.rest && Modes.animate) { try { Animator.showDefaultPose(); } catch { /* ignore */ } }
    return;
  }
  ensureAnimateMode();
  if (Animation.selected !== sample.animation) sample.animation.select();
  Timeline.setTime(Math.max(0, sample.time));
  Animator.preview();
}

/** Put the viewport back on the timeline's pose after rendering the rest pose. */
function restoreViewportPose() {
  if (Modes.animate && Animation.selected) { try { Animator.preview(); } catch { /* ignore */ } }
}

// ───────────────────────────── core pipeline ─────────────────────────────

interface RenderJob {
  size: [number, number];
  padding: number;
  directions: DirectionSpec[];
  bases: ViewBasis[];
  samples: Sample[];
  frame: FrameSpec;
  bounds: ViewBounds;
  style: StyleOptions;
  pass: RenderPassOptions;
  texel_density: number;
  sourceColors: RGB[] | null;
  warnings: string[];
}

function unionBounds(target: ViewBounds, b: ViewBounds) {
  target.umin = Math.min(target.umin, b.umin); target.umax = Math.max(target.umax, b.umax);
  target.vmin = Math.min(target.vmin, b.vmin); target.vmax = Math.max(target.vmax, b.vmax);
  target.dmin = Math.min(target.dmin, b.dmin); target.dmax = Math.max(target.dmax, b.dmax);
  target.any = target.any || b.any;
}

/** Reference models (player, crafting table …) that should be part of the sprite. */
function referenceModelObjects(include: boolean): any[] {
  if (!include || typeof PreviewModel === 'undefined') return [];
  try {
    return PreviewModel.getActiveModels().filter((m: any) => !m.internal && m.model_3d).map((m: any) => m.model_3d);
  } catch { return []; }
}

function prepareJob(params: any, directions: DirectionSpec[], samples: Sample[]): RenderJob {
  requireProject();
  const elements = renderableElements();
  const extraObjects = referenceModelObjects(params.include_reference_models === true);
  if (!elements.length && !extraObjects.length) fail('The project has no visible cubes or meshes to render.');
  const size = parseSize(params.size);
  const padding = clampInt(params.padding ?? 1, 0, Math.floor(Math.min(size[0], size[1]) / 4));
  const warnings: string[] = [];
  const bases = directions.map((d) => viewBasis(d.yaw, d.pitch));

  // Union of the projected bounds over every pose and every direction: one
  // scale and one pivot for the whole set, so frames never jump.
  const bounds: ViewBounds = { umin: Infinity, umax: -Infinity, vmin: Infinity, vmax: -Infinity, dmin: Infinity, dmax: -Infinity, origin: { u: 0, v: 0, d: 0 }, any: false };
  for (const sample of samples) {
    applyPose(sample);
    for (const basis of bases) unionBounds(bounds, projectBounds(basis, elements, extraObjects));
  }
  const texel_density = textureTexelDensity();
  const frame = fitFrame(bounds, {
    width: size[0], height: size[1], padding,
    pixels_per_unit: typeof params.pixels_per_unit === 'number' && params.pixels_per_unit > 0 ? params.pixels_per_unit : undefined,
    scale_snap: oneOf(params.scale_snap, ['texel', 'integer', 'half', 'none'] as const, 'texel', '"scale_snap"'),
    texel_density,
    anchor: oneOf(params.anchor, ['auto', 'origin', 'bounds', 'center'] as const, 'auto', '"anchor"'),
  });
  if (frame.clipped) {
    warnings.push(`At ${frame.pixels_per_unit} px per unit the model needs a ${frame.required_size[0]}x${frame.required_size[1]} frame but the frame is ${size[0]}x${size[1]} — parts are cut off. Use a bigger "size", a smaller "pixels_per_unit", or drop "pixels_per_unit" to auto-fit.`);
  }
  const style = parseStyle(params, size, frame.pixels_per_unit);
  if (style.outline === 'outer' && padding === 0) warnings.push('"outline": "outer" adds a 1 px border around the sprite but "padding" is 0, so the outline is clipped at the frame edge. Use padding ≥ 1.');
  const supersample = supersampleFor(size, params.supersample);
  const pass: RenderPassOptions = {
    supersample,
    alpha_threshold: typeof params.alpha_threshold === 'number' ? Math.max(0.05, Math.min(1, params.alpha_threshold)) : 0.5,
    sampling: oneOf(params.sampling, ['mode', 'center'] as const, 'mode', '"sampling"'),
    include_reference_models: params.include_reference_models === true,
    extra_objects: extraObjects,
  };
  let sourceColors: RGB[] | null = null;
  if (style.palette === 'source') {
    const collected = collectTextureColors();
    sourceColors = collected.colors;
    if (collected.truncated) warnings.push('The textures hold more than 4096 distinct colours — they are not pixel art, so "palette": "source" only used the first 4096. Prefer "palette": "auto" with "max_colors".');
  }
  return { size, padding, directions, bases, samples, frame, bounds, style, pass, texel_density, sourceColors, warnings };
}

interface RenderedCell {
  direction: DirectionSpec;
  sample: Sample;
  processed: ProcessedFrame;
  pivot: [number, number];
  mirrored: boolean;
}

async function renderJob(job: RenderJob, onProgress?: (done: number, total: number) => void): Promise<RenderedCell[]> {
  const cells: RenderedCell[] = [];
  const total = job.samples.length * job.directions.length;
  let done = 0;
  for (const sample of job.samples) {
    applyPose(sample);
    const byDirection = new Map<number, RenderedCell>();
    for (let i = 0; i < job.directions.length; i++) {
      const dir = job.directions[i];
      let cell: RenderedCell;
      if (dir.mirrored_from !== undefined && byDirection.has(dir.mirrored_from)) {
        const src = byDirection.get(dir.mirrored_from)!;
        const W = src.processed.width, H = src.processed.height;
        cell = {
          direction: dir, sample,
          processed: {
            ...src.processed,
            rgba: flipHorizontal(src.processed.rgba, W, H),
            normal_rgba: flipNormalMap(src.processed.normal_rgba, W, H),
          },
          pivot: [W - src.pivot[0], src.pivot[1]],
          mirrored: true,
        };
      } else {
        const buffers = renderPixelFrame(job.bases[i], job.frame, job.bounds, job.pass);
        const light = lightInViewSpace(job.style.light, dir.pitch);
        const processed = processFrame(buffers, job.style, light, job.sourceColors);
        cell = { direction: dir, sample, processed, pivot: [job.frame.pivot[0], job.frame.pivot[1]], mirrored: false };
      }
      byDirection.set(dir.index, cell);
      cells.push(cell);
      done++;
      onProgress?.(done, total);
    }
    // Let the renderer breathe between poses so long sets do not freeze the UI.
    await new Promise((r) => setTimeout(r, 0));
  }
  return cells;
}

function toSheetFrame(cell: RenderedCell, multiDirection: boolean, keyPrefix: string): SheetFrame {
  const { processed, direction, sample } = cell;
  const tag = multiDirection ? `${sample.tag}_${direction.name}` : sample.tag;
  return {
    key: `${keyPrefix}${tag}_${String(sample.time).replace('.', '_')}`,
    rgba: processed.rgba,
    normal_rgba: processed.normal_rgba,
    width: processed.width,
    height: processed.height,
    duration_ms: sample.duration_ms,
    tag,
    direction: direction.name,
    compass: direction.compass,
    time: sample.time,
    pivot: cell.pivot,
  };
}

function sanitizeName(name: string): string {
  return String(name).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'sprite';
}

function joinPath(dir: string, file: string): string {
  return PathModule.join(dir, file);
}

function aggregateStats(cells: RenderedCell[]) {
  const colors = new Set<number>();
  let outline = 0, lines = 0, opaque = 0;
  for (const c of cells) {
    const d = c.processed.rgba;
    for (let p = 0; p < d.length; p += 4) if (d[p + 3]) colors.add((d[p] << 16) | (d[p + 1] << 8) | d[p + 2]);
    outline += c.processed.stats.outline_pixels;
    lines += c.processed.stats.line_pixels;
    opaque += c.processed.stats.opaque_pixels;
  }
  return { distinct_colors: colors.size, outline_pixels: outline, inner_line_pixels: lines, opaque_pixels: opaque };
}

function frameSummary(job: RenderJob) {
  return {
    frame_size: job.size,
    pixels_per_unit: Math.round(job.frame.pixels_per_unit * 10000) / 10000,
    texel_size_px: Math.round((job.frame.pixels_per_unit / job.texel_density) * 10000) / 10000,
    texel_density: job.texel_density,
    supersample: job.pass.supersample,
    pivot: job.frame.pivot,
    pivot_note: 'Model origin (0,0,0) in frame pixels from the top-left corner — use as the sprite anchor (feet).',
    anchor: job.frame.anchor,
    padding: job.padding,
    model_extent_units: {
      width: Math.round((job.bounds.umax - job.bounds.umin) * 100) / 100,
      height: Math.round((job.bounds.vmax - job.bounds.vmin) * 100) / 100,
    },
  };
}

// ───────────────────────────── commands ─────────────────────────────

register('render_pixel_art', async (params) => {
  requireProject();
  const views: string[] = Array.isArray(params.views) && params.views.length ? params.views : [params.view ?? 'side'];
  const directionCount = clampInt(params.directions ?? 1, 1, 16);
  let directions: DirectionSpec[];
  let viewInfo: { name: string; yaw: number; pitch: number };
  if (directionCount > 1) {
    if (views.length > 1) fail('Use either "views" (several presets) or "directions" (rotation set), not both.');
    viewInfo = resolveView(views[0], params.yaw, params.pitch);
    directions = buildDirections(directionCount, viewInfo.yaw, viewInfo.pitch, params.mirror_directions === true);
  } else {
    viewInfo = resolveView(views[0], params.yaw, params.pitch);
    directions = views.map((v, i) => {
      const r = resolveView(v, views.length === 1 ? params.yaw : undefined, views.length === 1 ? params.pitch : undefined);
      return { index: i, yaw: r.yaw, pitch: r.pitch, name: r.name, compass: '' };
    });
  }
  const { samples } = planSamples({ ...params, animations: undefined, animation: params.animation, times: undefined, frames: undefined });
  const single = samples.slice(0, 1);
  let job: RenderJob;
  let cells: RenderedCell[];
  try {
    job = prepareJob(params, directions, single);
    cells = await renderJob(job);
  } finally {
    restoreViewportPose();
  }

  const frames = cells.map((c) => toSheetFrame(c, directionCount > 1, ''));
  const strip = packSheet(frames, { columns: Math.min(frames.length, 8), padding: 2, margin: 0, extrude: 0, pot: false }, false);
  const scale = typeof params.preview_scale === 'number' ? clampInt(params.preview_scale, 1, 16) : previewScaleFor(strip.width, strip.height, 640);
  const files: string[] = [];
  if (params.directory) {
    const name = sanitizeName(params.name || `${Project.name || 'model'}_pixelart`);
    for (const cell of cells) {
      const label = cell.direction.name;
      const file = joinPath(params.directory, `${name}_${sanitizeName(label)}.png`);
      writePng(file, rgbaToPngDataUrl(cell.processed.rgba, cell.processed.width, cell.processed.height));
      files.push(file);
      if (params.normal_map) {
        const nfile = joinPath(params.directory, `${name}_${sanitizeName(label)}_normal.png`);
        writePng(nfile, rgbaToPngDataUrl(cell.processed.normal_rgba, cell.processed.width, cell.processed.height));
        files.push(nfile);
      }
    }
  }
  return {
    views: cells.map((c) => ({
      name: c.direction.name,
      compass: directionCount > 1 ? c.direction.compass : undefined,
      yaw: Math.round(c.direction.yaw * 100) / 100,
      pitch: Math.round(c.direction.pitch * 100) / 100,
      mirrored: c.mirrored || undefined,
      colors: c.processed.stats.colors,
      opaque_pixels: c.processed.stats.opaque_pixels,
      outline_pixels: c.processed.stats.outline_pixels || undefined,
      inner_line_pixels: c.processed.stats.line_pixels || undefined,
    })),
    ...frameSummary(job),
    style: describeStyle(job.style),
    pose: single[0].animation ? { animation: single[0].tag, time: single[0].time } : (single[0].rest ? 'rest' : 'current viewport pose'),
    files: files.length ? files : undefined,
    preview: `The image is a contact strip of the ${cells.length} frame(s) at ${scale}x nearest-neighbour zoom (real size ${job.size[0]}x${job.size[1]}). Pass "directory" to write the true-size PNGs.`,
    warnings: job.warnings.length ? job.warnings : undefined,
    __image: upscaledPreview(strip.rgba, strip.width, strip.height, scale),
  };
});

register('export_pixel_sprites', async (params) => {
  requireProject();
  const viewInfo = resolveView(params.view ?? 'side', params.yaw, params.pitch);
  const directionCount = clampInt(params.directions ?? 1, 1, 16);
  const directions = buildDirections(directionCount, viewInfo.yaw, viewInfo.pitch, params.mirror_directions === true);
  const { samples, animations, fps } = planSamples(params);
  if (samples.length * directions.length > 2048) fail(`${samples.length} frames x ${directions.length} directions = ${samples.length * directions.length} renders — too many. Lower "fps"/"frames" or "directions".`);
  let job: RenderJob;
  let cells: RenderedCell[];
  try {
    job = prepareJob(params, directions, samples);
    cells = await renderJob(job);
  } finally {
    restoreViewportPose();
  }

  const output = params.output || {};
  const layout: SheetLayoutOptions = {
    columns: typeof output.columns === 'number' && output.columns > 0 ? Math.round(output.columns) : undefined,
    padding: clampInt(output.padding ?? 1, 0, 64),
    margin: clampInt(output.margin ?? 0, 0, 64),
    extrude: clampInt(output.extrude ?? 0, 0, 8),
    pot: output.pot === true,
  };
  // Row per (animation, direction) unless a column count is forced.
  const frames = cells.map((c) => toSheetFrame(c, directions.length > 1, ''));
  // Order rows: animation-major, direction-minor (all frames of one direction in a row).
  const ordered: SheetFrame[] = [];
  const tagsInOrder: string[] = [];
  for (const f of frames) if (!tagsInOrder.includes(f.tag)) tagsInOrder.push(f.tag);
  for (const tag of tagsInOrder) for (const f of frames) if (f.tag === tag) ordered.push(f);
  const sheet = packSheet(ordered, layout, !layout.columns);

  const name = sanitizeName(output.name || params.name || `${Project.name || 'model'}_${animations.length ? animations.map((a) => a.name.replace(/^animation\./, '')).join('_') : 'sprites'}`);
  const directory: string | undefined = output.directory || params.directory;
  const files: Record<string, string> = {};
  const writeSheet = output.sheet !== false;
  const writeFrames = output.frames === true;
  const writeJson = output.json !== 'none' && output.json !== false;
  const writeNormal = output.normal_map === true;
  const meta = {
    image: `${name}.png`,
    app_version: PLUGIN_VERSION,
    pixels_per_unit: job.frame.pixels_per_unit,
    frame_size: job.size,
    view: viewInfo,
    directions: directions.map((d) => ({ index: d.index, name: d.name, compass: d.compass, yaw: Math.round(d.yaw * 100) / 100, mirrored_from: d.mirrored_from })),
    style: describeStyle(job.style),
    animations,
    extra: { fps, anchor: job.frame.anchor, texel_density: job.texel_density, pivot: { x: job.frame.pivot[0], y: job.frame.pivot[1] } },
  };
  const json = asepriteJson(sheet, meta, output.json === 'array' ? 'array' : 'hash');
  if (directory) {
    if (writeSheet) {
      const file = joinPath(directory, `${name}.png`);
      writePng(file, rgbaToPngDataUrl(sheet.rgba, sheet.width, sheet.height));
      files.sheet = file;
    }
    if (writeNormal && sheet.normal_rgba) {
      const file = joinPath(directory, `${name}_normal.png`);
      writePng(file, rgbaToPngDataUrl(sheet.normal_rgba, sheet.width, sheet.height));
      files.normal_map = file;
    }
    if (writeJson) {
      const file = joinPath(directory, `${name}.json`);
      writeText(file, JSON.stringify(json, null, 2));
      files.json = file;
    }
    if (writeFrames) {
      // Flat files next to the sheet: the plugin cannot create sub-folders
      // (Blockbench gates fs behind a permission modal).
      let i = 0;
      let first = '';
      for (const cell of sheet.cells) {
        const f = cell.frame;
        const file = joinPath(directory, `${name}_${sanitizeName(f.tag)}_${String(i).padStart(3, '0')}.png`);
        writePng(file, rgbaToPngDataUrl(f.rgba, f.width, f.height));
        if (!first) first = file;
        i++;
      }
      files.frames_pattern = joinPath(directory, `${name}_<tag>_<index>.png`);
      files.first_frame = first;
      files.frame_count = String(i);
    }
    if (output.preview_file === true) {
      const file = joinPath(directory, `${name}_preview.png`);
      writePng(file, upscaledPreview(sheet.rgba, sheet.width, sheet.height, previewScaleFor(sheet.width, sheet.height, 1024), false));
      files.preview = file;
    }
  }
  const scale = typeof params.preview_scale === 'number' ? clampInt(params.preview_scale, 1, 16) : previewScaleFor(sheet.width, sheet.height, 768);
  const stats = aggregateStats(cells);
  return {
    name,
    files: directory ? files : undefined,
    note: directory ? undefined : 'No "output.directory" given — nothing was written. Pass an absolute folder (see get_status "paths") to save the sheet, JSON and frames.',
    sheet: { width: sheet.width, height: sheet.height, columns: sheet.columns, rows: sheet.rows, cells: sheet.cells.length, padding: layout.padding, margin: layout.margin, extrude: layout.extrude, layout: layout.columns ? `grid (${layout.columns} columns)` : 'one row per animation/direction' },
    ...frameSummary(job),
    fps,
    animations: animations.length ? animations : 'static (no animation)',
    directions: directions.map((d) => ({ name: d.name, compass: d.compass, yaw: Math.round(d.yaw * 100) / 100, mirrored_from: d.mirrored_from !== undefined ? directions[d.mirrored_from].name : undefined })),
    frame_tags: json.meta.frameTags,
    style: describeStyle(job.style),
    stats,
    warnings: job.warnings.length ? job.warnings : undefined,
    preview: `Sheet preview at ${scale}x nearest-neighbour zoom (real size ${sheet.width}x${sheet.height}).`,
    __image: upscaledPreview(sheet.rgba, sheet.width, sheet.height, scale),
  };
});

register('pixel_art_presets', () => {
  return {
    views: Object.fromEntries(Object.entries(VIEW_PRESETS).map(([k, v]) => [k, `${v.description} (yaw ${v.yaw}, pitch ${v.pitch})`])),
    styles: {
      outlined: 'toon shading + selective outer outline + depth inner lines (default)',
      clean: 'toon shading, no outline',
      minecraft: 'Blockbench face shading (top 100% / sides 80%,60% / bottom 50%), no outline',
      flat: 'texture colours only',
    },
    palettes: Object.fromEntries(Object.entries(PALETTES).map(([k, v]) => [k, `${v.name}: ${v.colors.length} colours`])),
    direction_names: { screen: ['down', 'down_right', 'right', 'up_right', 'up', 'up_left', 'left', 'down_left'], compass: ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW'] },
    defaults: {
      size: 32, padding: 1, scale_snap: 'texel', anchor: 'auto', supersample: 'auto (4 for ≤64 px, 3 for ≤128, 2 above)', alpha_threshold: 0.5, sampling: 'mode',
      shade_levels: '2 for ≤16 px, 3 for ≤48 px, 4 above', light: [-0.35, 0.75, 0.45], palette: 'source', dither: 'none', cleanup: 'specks', pixel_perfect: true, alpha_bleed: true, fps: 12,
    },
    valid_views: viewPresetNames(),
  };
});
