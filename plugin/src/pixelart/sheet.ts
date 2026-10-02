// Sprite sheets: fixed-cell packing with padding/margin/extrude, PNG encoding
// through a canvas, nearest-neighbour previews, and Aseprite-compatible JSON
// metadata (frames, frameTags, slices with pivots) plus a "pixelart" block
// with the scale, pivot and direction data engines need.

export interface SheetFrame {
  /** Row (direction/animation) and column (frame) indices in the grid. */
  key: string;
  rgba: Uint8ClampedArray;
  normal_rgba?: Uint8ClampedArray;
  width: number;
  height: number;
  duration_ms: number;
  tag: string;
  direction?: string;
  compass?: string;
  time?: number;
  pivot: [number, number];
}

export interface SheetLayoutOptions {
  /** Cells per row; rows break when reached. Default: frames per tag (one row per direction/animation). */
  columns?: number;
  /** Transparent gap between cells. */
  padding: number;
  /** Transparent border around the sheet. */
  margin: number;
  /** Pixels of edge replication around each cell (inside the padding). */
  extrude: number;
  /** Pad the sheet to a power-of-two square/rectangle. */
  pot: boolean;
}

export interface PackedSheet {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  normal_rgba?: Uint8ClampedArray;
  cells: { frame: SheetFrame; x: number; y: number; w: number; h: number; row: number; col: number }[];
  columns: number;
  rows: number;
}

function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p *= 2;
  return p;
}

/** Copy `src` (w×h RGBA) into `dst` at (dx, dy) with `extrude` px of edge replication. */
function blit(dst: Uint8ClampedArray, dstW: number, dstH: number, src: Uint8ClampedArray, w: number, h: number, dx: number, dy: number, extrude: number) {
  for (let y = -extrude; y < h + extrude; y++) {
    const sy = Math.max(0, Math.min(h - 1, y));
    const ty = dy + y;
    if (ty < 0 || ty >= dstH) continue;
    for (let x = -extrude; x < w + extrude; x++) {
      const sx = Math.max(0, Math.min(w - 1, x));
      const tx = dx + x;
      if (tx < 0 || tx >= dstW) continue;
      const s = (sy * w + sx) * 4, d = (ty * dstW + tx) * 4;
      dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
    }
  }
}

/** Pack frames in row-major order; a new row starts whenever the tag changes or `columns` is reached. */
export function packSheet(frames: SheetFrame[], opts: SheetLayoutOptions, breakOnTag = true): PackedSheet {
  if (!frames.length) throw new Error('No frames to pack');
  const cw = Math.max(...frames.map((f) => f.width));
  const ch = Math.max(...frames.map((f) => f.height));
  const cells: PackedSheet['cells'] = [];
  let row = 0, col = 0, maxCol = 0;
  let lastTag = frames[0].tag;
  const columns = opts.columns && opts.columns > 0 ? Math.round(opts.columns) : Infinity;
  for (const frame of frames) {
    if ((breakOnTag && frame.tag !== lastTag && col > 0) || col >= columns) { row++; col = 0; }
    lastTag = frame.tag;
    cells.push({ frame, x: 0, y: 0, w: frame.width, h: frame.height, row, col });
    maxCol = Math.max(maxCol, col + 1);
    col++;
  }
  const rows = row + 1;
  const stride = cw + 2 * opts.extrude + opts.padding;
  const strideY = ch + 2 * opts.extrude + opts.padding;
  let width = 2 * opts.margin + maxCol * stride - opts.padding;
  let height = 2 * opts.margin + rows * strideY - opts.padding;
  if (opts.pot) { width = nextPow2(width); height = nextPow2(height); }
  const rgba = new Uint8ClampedArray(width * height * 4);
  const hasNormal = frames.some((f) => f.normal_rgba);
  const normal = hasNormal ? new Uint8ClampedArray(width * height * 4) : undefined;
  for (const cell of cells) {
    cell.x = opts.margin + opts.extrude + cell.col * stride;
    cell.y = opts.margin + opts.extrude + cell.row * strideY;
    blit(rgba, width, height, cell.frame.rgba, cell.frame.width, cell.frame.height, cell.x, cell.y, opts.extrude);
    if (normal && cell.frame.normal_rgba) blit(normal, width, height, cell.frame.normal_rgba, cell.frame.width, cell.frame.height, cell.x, cell.y, opts.extrude);
  }
  return { width, height, rgba, normal_rgba: normal, cells, columns: maxCol, rows };
}

// ───────────────────────────── PNG / preview ─────────────────────────────

export function rgbaToCanvas(rgba: Uint8ClampedArray, width: number, height: number): any {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function rgbaToPngDataUrl(rgba: Uint8ClampedArray, width: number, height: number): string {
  return rgbaToCanvas(rgba, width, height).toDataURL('image/png');
}

/** Integer nearest-neighbour upscale so tiny sprites are legible in a chat. */
export function upscaledPreview(rgba: Uint8ClampedArray, width: number, height: number, scale: number, checker = true): string {
  const s = Math.max(1, Math.round(scale));
  const src = rgbaToCanvas(rgba, width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width * s;
  canvas.height = height * s;
  const ctx = canvas.getContext('2d');
  if (checker) {
    // Light checkerboard so transparency and white pixels stay distinguishable.
    const cell = Math.max(4, s * 4);
    for (let y = 0; y < canvas.height; y += cell) {
      for (let x = 0; x < canvas.width; x += cell) {
        ctx.fillStyle = ((x / cell + y / cell) % 2 === 0) ? '#d8d8d8' : '#bfbfbf';
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/** Preview scale that brings the longer side to roughly `target` px. */
export function previewScaleFor(width: number, height: number, target = 384): number {
  return Math.max(1, Math.min(16, Math.floor(target / Math.max(width, height))));
}

// ───────────────────────────── files ─────────────────────────────

export function writePng(path: string, dataUrl: string) {
  Blockbench.writeFile(path, { savetype: 'image', content: dataUrl });
}

export function writeText(path: string, content: string) {
  Blockbench.writeFile(path, { content });
}

// Directory creation happens on the MCP server side (a plain Node process)
// before the command reaches the plugin: Blockbench gates require('fs') for
// plugins behind a synchronous permission modal, and Blockbench.writeFile does
// not create missing folders.

// ───────────────────────────── metadata ─────────────────────────────

export interface SheetMeta {
  image: string;
  app_version: string;
  pixels_per_unit: number;
  frame_size: [number, number];
  view: { name: string; yaw: number; pitch: number };
  directions: { index: number; name: string; compass: string; yaw: number; mirrored_from?: number }[];
  style: any;
  animations: { name: string; fps: number; loop: string; length: number }[];
  extra?: Record<string, any>;
}

/** Aseprite-compatible JSON (hash format) with pivot slices and a pixelart block. */
export function asepriteJson(sheet: PackedSheet, meta: SheetMeta, format: 'hash' | 'array' = 'hash'): any {
  const frames: any = format === 'array' ? [] : {};
  const tags: { name: string; from: number; to: number; direction: string }[] = [];
  const slices: any[] = [];
  let tagStart = 0;
  let lastTag = '';
  sheet.cells.forEach((cell, i) => {
    const f = cell.frame;
    const entry = {
      frame: { x: cell.x, y: cell.y, w: cell.w, h: cell.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: cell.w, h: cell.h },
      sourceSize: { w: cell.w, h: cell.h },
      duration: Math.max(1, Math.round(f.duration_ms)),
    };
    if (format === 'array') frames.push({ filename: f.key, ...entry });
    else frames[f.key] = entry;
    if (f.tag !== lastTag) {
      if (lastTag) tags.push({ name: lastTag, from: tagStart, to: i - 1, direction: 'forward' });
      lastTag = f.tag;
      tagStart = i;
    }
  });
  if (lastTag) tags.push({ name: lastTag, from: tagStart, to: sheet.cells.length - 1, direction: 'forward' });
  const pivotKeys = sheet.cells.map((cell, i) => ({
    frame: i,
    bounds: { x: 0, y: 0, w: cell.w, h: cell.h },
    pivot: { x: cell.frame.pivot[0], y: cell.frame.pivot[1] },
  }));
  slices.push({ name: 'pivot', color: '#0000ffff', keys: pivotKeys });
  return {
    frames,
    meta: {
      app: 'https://github.com/BlockBenchMCP',
      version: meta.app_version,
      image: meta.image,
      format: 'RGBA8888',
      size: { w: sheet.width, h: sheet.height },
      scale: '1',
      frameTags: tags,
      layers: [{ name: 'sprite', opacity: 255, blendMode: 'normal' }],
      slices,
      pixelart: {
        pixels_per_unit: meta.pixels_per_unit,
        frame_size: { w: meta.frame_size[0], h: meta.frame_size[1] },
        columns: sheet.columns,
        rows: sheet.rows,
        view: meta.view,
        directions: meta.directions,
        animations: meta.animations,
        style: meta.style,
        frames: sheet.cells.map((cell) => ({
          key: cell.frame.key,
          tag: cell.frame.tag,
          direction: cell.frame.direction,
          compass: cell.frame.compass,
          time: cell.frame.time,
          pivot: { x: cell.frame.pivot[0], y: cell.frame.pivot[1] },
          pivot_normalized: { x: cell.frame.pivot[0] / cell.w, y: cell.frame.pivot[1] / cell.h },
        })),
        ...(meta.extra || {}),
      },
    },
  };
}
