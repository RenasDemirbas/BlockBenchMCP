// Pixel drawing for paint_texture: one op onto a 2D context, in texture pixel space.
import { fail } from '../registry';
import { hash01 } from '../util';
import { faceMask, forEachTexel, SurfaceFace } from '../surface';

/** Face geometry for targeted ops: pixel rect, world Y span, v-flip. */
export type PaintGeo = {
  rect: number[]; worldY: [number, number]; vFlipped: boolean; rotated: boolean;
  /** Mesh faces: the UV polygon's texel mask — paint outside it is reverted. */
  mask?: ReturnType<typeof faceMask>;
  surf?: SurfaceFace;
} | null;

type GradientStop = { at: number; color: string; opacity?: number };

/** Resolve a stop to a CSS rgba string, folding in its own opacity. */
function stopColor(stop: GradientStop): string {
  const tc = (window as any).tinycolor(stop.color);
  return stop.opacity == null ? tc.toRgbString() : tc.setAlpha(stop.opacity).toRgbString();
}

/** Interpolate a stop ramp at t — used where a world sweep collapses to one Y. */
function sampleStops(stops: GradientStop[], t: number): string {
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  if (t <= sorted[0].at) return stopColor(sorted[0]);
  const last = sorted[sorted.length - 1];
  if (t >= last.at) return stopColor(last);
  for (let i = 1; i < sorted.length; i++) {
    if (t > sorted[i].at) continue;
    const a = sorted[i - 1], b = sorted[i];
    const f = (b.at - a.at) ? (t - a.at) / (b.at - a.at) : 0;
    const ca = (window as any).tinycolor(stopColor(a)).toRgb();
    const cb = (window as any).tinycolor(stopColor(b)).toRgb();
    const lerp = (x: number, y: number) => x + (y - x) * f;
    return `rgba(${Math.round(lerp(ca.r, cb.r))}, ${Math.round(lerp(ca.g, cb.g))}, ${Math.round(lerp(ca.b, cb.b))}, ${lerp(ca.a, cb.a)})`;
  }
  return stopColor(last);
}

/** rect/ellipse draw an outline when asked (filled: false) or when only a line thickness is given. */
export function isOutline(op: any): boolean {
  return op.filled === false || (op.filled == null && op.thickness != null);
}

/** Where the context sits: layer offset, texture size, and the model Y extent for space: "world". */
export interface PaintEnv {
  canvas: HTMLCanvasElement;
  ox: number;
  oy: number;
  texW: number;
  texH: number;
  modelY: number[];
}

export function drawPaintOp(ctx: CanvasRenderingContext2D, op: any, map: (pt: number[]) => [number, number], geo: PaintGeo, env: PaintEnv) {
  const { canvas, ox, oy, texW, texH, modelY } = env;
  const color = op.color || '#000000';
  ctx.globalAlpha = op.opacity ?? 1;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  const px = (pt: number[]) => map(pt);

  if (op.type === 'pixel') {
    for (const p of op.pixels || []) {
      const [x, y] = px(p);
      ctx.fillRect(x, y, 1, 1);
    }
  } else if (op.type === 'line') {
    const [x0, y0] = px(op.from), [x1, y1] = px(op.to);
    const t = Math.max(1, Math.round(op.thickness ?? 1));
    const half = Math.floor((t - 1) / 2);
    // Bresenham for pixel-perfect lines
    let x = x0, y = y0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      ctx.fillRect(x - half, y - half, t, t);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  } else if (op.type === 'rect') {
    const [x0, y0] = px(op.from), [x1, y1] = px(op.to);
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0) + (op.target ? 0 : 1);
    const h = Math.abs(y1 - y0) + (op.target ? 0 : 1);
    if (isOutline(op)) {
      const t = Math.max(1, Math.round(op.thickness ?? 1));
      ctx.fillRect(x, y, w, t);
      ctx.fillRect(x, y + h - t, w, t);
      ctx.fillRect(x, y, t, h);
      ctx.fillRect(x + w - t, y, t, h);
    } else {
      ctx.fillRect(x, y, w, h);
    }
  } else if (op.type === 'ellipse') {
    const [cx, cy] = px(op.center);
    const rx = Math.max(0.5, op.radius?.[0] ?? op.radius ?? 4);
    const ry = Math.max(0.5, op.radius?.[1] ?? op.radius ?? 4);
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
        const d = nx * nx + ny * ny;
        if (isOutline(op)) {
          const nx2 = (x + 0.5 - cx) / (rx - 1 || 0.5), ny2 = (y + 0.5 - cy) / (ry - 1 || 0.5);
          if (d <= 1 && nx2 * nx2 + ny2 * ny2 > 1) ctx.fillRect(x, y, 1, 1);
        } else if (d <= 1) {
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  } else if (op.type === 'fill') {
    const [sx, sy] = px(op.at);
    // Pixel reads/writes ignore the context transform: go to layer space.
    floodFill(ctx, canvas, sx - ox, sy - oy, color, op.opacity ?? 1, op.tolerance ?? 0);
  } else if (op.type === 'gradient') {
    const stops: GradientStop[] = Array.isArray(op.stops) && op.stops.length
      ? op.stops
      : [{ at: 0, color: op.color || '#000000' }, { at: 1, color: op.color2 || 'rgba(0,0,0,0)' }];
    const addStops = (grad: CanvasGradient) => {
      for (const s of stops) grad.addColorStop(Math.max(0, Math.min(1, s.at)), stopColor(s));
    };

    if (op.space === 'world' && geo?.surf) {
      // Mesh face: UVs can be any shape, so sample the ramp per texel from
      // its interpolated world height.
      const [my0, my1] = op.range && op.range.length === 2 ? op.range : modelY;
      forEachTexel(geo.surf, (tx, ty, w) => {
        const t = my1 === my0 ? 0 : 1 - (w[1] - my0) / (my1 - my0);
        ctx.fillStyle = sampleStops(stops, Math.max(0, Math.min(1, t)));
        ctx.fillRect(tx, ty, 1, 1);
      }, 'conservative');
      return;
    }
    if (op.space === 'world' && geo) {
      // Lay the gradient line along the MODEL's Y extent rather than this
      // face's box. The line runs past the face rect, so neighbouring cubes
      // pick up the same ramp and the seam between them disappears.
      const [fy0, fy1] = geo.worldY;
      const [my0, my1] = op.range && op.range.length === 2 ? op.range : modelY;
      const [rx, ry, rw, rh] = geo.rect;
      if (Math.abs(fy1 - fy0) < 1e-6) {
        // up/down face: one constant height → flat sample off the ramp.
        const t = my1 === my0 ? 0 : 1 - (fy1 - my0) / (my1 - my0);
        ctx.fillStyle = sampleStops(stops, Math.max(0, Math.min(1, t)));
      } else {
        const pxPerUnit = rh / (fy1 - fy0);
        const top = geo.vFlipped ? ry + rh : ry;      // pixel row of the face's world-top edge
        const bottom = geo.vFlipped ? ry : ry + rh;   // ...and of its world-bottom edge
        const dir = geo.vFlipped ? -1 : 1;
        const pTop = top - dir * (my1 - fy1) * pxPerUnit;
        const pBot = bottom + dir * (fy0 - my0) * pxPerUnit;
        const grad = ctx.createLinearGradient(rx, pTop, rx, pBot);
        addStops(grad);
        ctx.fillStyle = grad;
      }
      ctx.fillRect(rx, ry, rw, rh);
      return;
    }

    // Face-local (or absolute pixel) sweep; a targeted op defaults to top→bottom.
    const [x0, y0] = px(op.from ?? [0, 0]), [x1, y1] = px(op.to ?? [0, 1]);
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    addStops(grad);
    ctx.fillStyle = grad;
    // A targeted gradient must stay on the face — default the clip to the
    // face rect instead of flooding the whole texture.
    const clip = op.clip ?? (op.target ? { from: [0, 0], to: [1, 1] } : null);
    if (clip) {
      const [cx0, cy0] = px(clip.from), [cx1, cy1] = px(clip.to);
      const pad = op.target ? 0 : 1; // normalized [1,1] already maps to the exclusive face edge
      ctx.fillRect(Math.min(cx0, cx1), Math.min(cy0, cy1), Math.abs(cx1 - cx0) + pad, Math.abs(cy1 - cy0) + pad);
    } else {
      ctx.fillRect(0, 0, texW, texH);
    }
  } else if (op.type === 'clear') {
    const [x0, y0] = px(op.from), [x1, y1] = px(op.to);
    ctx.clearRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) + 1, Math.abs(y1 - y0) + 1);
  } else if (op.type === 'jagged_edge' || op.type === 'noise' || op.type === 'strands') {
    const from = op.from ?? [0, 0];
    // No target and no rect means the whole bitmap — speckling an entire
    // atlas in one op is the common case. A targeted op spans its face.
    const to = op.to ?? (op.target ? [1, 1] : [texW - 1, texH - 1]);
    const [ax0, ay0] = px(from), [ax1, ay1] = px(to);
    const x = Math.min(ax0, ax1), y = Math.min(ay0, ay1);
    const w = Math.abs(ax1 - ax0) + (op.target ? 0 : 1);
    const h = Math.abs(ay1 - ay0) + (op.target ? 0 : 1);
    const seed = op.seed ?? 1;

    if (op.type === 'noise') {
      // Seeded speckle — fur/stone/organic surface variation.
      const density = Math.max(0, Math.min(1, op.density ?? 0.15));
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          if (hash01(x + xx, y + yy, seed) >= density) continue;
          ctx.fillStyle = op.color2 && hash01(x + xx, y + yy, seed + 7) < 0.5 ? op.color2 : color;
          ctx.fillRect(x + xx, y + yy, 1, 1);
        }
      }
      ctx.fillStyle = color;
    } else if (op.type === 'strands') {
      // Seeded fur dashes. Count and length come from the rect's own size,
      // so the same op reads consistently on a 6px paw and a 40px flank —
      // many SHORT dashes look like fur, a few long ones look like wood grain.
      const baseAlpha = op.opacity ?? 1;
      const dir = op.direction || 'down';
      if (!['down', 'up', 'left', 'right'].includes(dir)) fail(`strands "direction" must be down, up, left or right.`);
      const vertical = dir === 'down' || dir === 'up';
      const along = vertical ? w : h;   // spread strand starts across this
      const across = vertical ? h : w;  // measure strand length along this
      if (w >= 1 && h >= 1 && along >= 1 && across >= 1) {
        const density = Math.max(0, Math.min(2, op.density ?? 0.15));
        const range = Array.isArray(op.length) ? op.length : [0.1, 0.3];
        const lmin = Math.max(0.01, Math.min(1, range[0] ?? 0.1));
        const lmax = Math.max(lmin, Math.min(1, range[1] ?? 0.3));
        const lightRatio = Math.max(0, Math.min(1, op.light_ratio ?? 0.35));
        const lightAlpha = op.opacity2 ?? 0.6;
        const count = Math.max(1, Math.round(w * h * density));
        for (let i = 0; i < count; i++) {
          const a = Math.min(along - 1, Math.floor(hash01(i, 1, seed) * along));
          const len = Math.max(1, Math.min(across, Math.round(across * (lmin + hash01(i, 2, seed) * (lmax - lmin)))));
          const off = Math.floor(hash01(i, 3, seed) * Math.max(1, across - len + 1));
          const light = hash01(i, 4, seed) < lightRatio;
          ctx.fillStyle = light ? (op.color2 || '#ffffff') : color;
          ctx.globalAlpha = baseAlpha * (light ? lightAlpha : 1);
          if (dir === 'down') ctx.fillRect(x + a, y + off, 1, len);
          else if (dir === 'up') ctx.fillRect(x + a, y + across - off - len, 1, len);
          else if (dir === 'right') ctx.fillRect(x + off, y + a, len, 1);
          else ctx.fillRect(x + across - off - len, y + a, len, 1);
        }
        // Optional darker band where the fur meets the body.
        const root = Math.max(0, Math.min(1, op.root ?? 0));
        if (root > 0) {
          ctx.globalAlpha = baseAlpha;
          ctx.fillStyle = op.root_color || color;
          const t = Math.max(1, Math.round(across * root));
          if (dir === 'down') ctx.fillRect(x, y + h - t, w, t);
          else if (dir === 'up') ctx.fillRect(x, y, w, t);
          else if (dir === 'right') ctx.fillRect(x + w - t, y, t, h);
          else ctx.fillRect(x, y, t, h);
        }
      }
      ctx.globalAlpha = op.opacity ?? 1;
      ctx.fillStyle = color;
    } else {
      // Pixel-art fur teeth along one edge of the rect. mode "erase"
      // (default) cuts the silhouette into transparency — the fur-tuft
      // look on alpha planes; mode "color" draws colored teeth (layering).
      const edge = op.edge || 'top';
      if (!['top', 'bottom', 'left', 'right'].includes(edge)) fail(`jagged_edge "edge" must be top, bottom, left or right.`);
      const vertical = edge === 'left' || edge === 'right';
      const span = vertical ? h : w;
      const maxDepth = Math.max(1, Math.round(op.depth ?? Math.max(2, (vertical ? w : h) * 0.4)));
      const minDepth = Math.max(0, Math.round(op.min_depth ?? 0));
      const toothW = Math.max(1, Math.round(op.tooth_width ?? 2));
      const erase = (op.mode ?? 'erase') === 'erase';
      for (let i = 0; i < span; i++) {
        const k = Math.floor(i / toothW);
        const peak = minDepth + hash01(k, 3, seed) * (maxDepth - minDepth);
        const p = toothW === 1 ? 0.5 : (i % toothW) / (toothW - 1 || 1);
        const tri = 1 - Math.abs(2 * p - 1); // 1 at tooth center, 0 at boundaries
        // Deepest cut at tooth boundaries → remaining material forms spikes
        const d = Math.round(minDepth + (peak - minDepth) * (1 - tri) + (1 - tri));
        if (d <= 0) continue;
        let rx: number, ry: number, rw: number, rh: number;
        if (edge === 'top') { rx = x + i; ry = y; rw = 1; rh = Math.min(d, h); }
        else if (edge === 'bottom') { rx = x + i; ry = y + h - Math.min(d, h); rw = 1; rh = Math.min(d, h); }
        else if (edge === 'left') { rx = x; ry = y + i; rw = Math.min(d, w); rh = 1; }
        else { rx = x + w - Math.min(d, w); ry = y + i; rw = Math.min(d, w); rh = 1; }
        if (erase) ctx.clearRect(rx, ry, rw, rh);
        else ctx.fillRect(rx, ry, rw, rh);
      }
    }
  }
}

function floodFill(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, sx: number, sy: number, color: string, opacity: number, tolerance: number) {
  const w = canvas.width, h = canvas.height;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  // Parse fill color via a 1px scratch canvas
  const scratch = document.createElement('canvas');
  scratch.width = scratch.height = 1;
  const sctx = scratch.getContext('2d')!;
  sctx.fillStyle = color;
  sctx.globalAlpha = opacity;
  sctx.fillRect(0, 0, 1, 1);
  const [fr, fg, fb, fa] = sctx.getImageData(0, 0, 1, 1).data;
  const idx = (x: number, y: number) => (y * w + x) * 4;
  const si = idx(sx, sy);
  const target = [data[si], data[si + 1], data[si + 2], data[si + 3]];
  if (target[0] === fr && target[1] === fg && target[2] === fb && target[3] === fa) return;
  const tol = tolerance * 2.55 * 4;
  const matches = (i: number) =>
    Math.abs(data[i] - target[0]) + Math.abs(data[i + 1] - target[1]) + Math.abs(data[i + 2] - target[2]) + Math.abs(data[i + 3] - target[3]) <= tol;
  const stack: [number, number][] = [[sx, sy]];
  const visited = new Uint8Array(w * h);
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const vi = y * w + x;
    if (visited[vi]) continue;
    visited[vi] = 1;
    const i = idx(x, y);
    if (!matches(i)) continue;
    data[i] = fr; data[i + 1] = fg; data[i + 2] = fb; data[i + 3] = fa;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  ctx.putImageData(img, 0, 0);
}
