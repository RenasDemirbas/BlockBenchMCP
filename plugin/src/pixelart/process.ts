// Turns the raw pixel buffers of a frame into finished pixel art: banded
// (cel) shading with hue-shifted ramps, depth-based inner lines, selective
// outlines, palette snapping with optional ordered dithering, and the cleanup
// passes pixel artists apply by hand (orphan removal, pixel-perfect corners,
// alpha bleeding for engines that filter).
import { PixelBuffers } from './render';
import { RGB, RampOptions, shadeColor, scaleLightness, rgbKey, keyToRgb, PaletteMatcher, quantizeColors, bayerThreshold } from './color';
import { V3 } from './camera';

export type PaletteMode = 'source' | 'auto' | 'none' | RGB[];

export interface StyleOptions {
  shading: 'toon' | 'blockbench' | 'flat';
  shade_levels: number;
  /** Light direction in the camera-horizontal frame: x = image right, y = up, z = toward the camera. */
  light: V3;
  ramp: Required<RampOptions>;
  outline: 'none' | 'outer' | 'inner';
  outline_color: 'auto' | RGB;
  outline_connectivity: 4 | 8;
  /** Which inner-line detectors run: depth steps, normal creases, part (bone) boundaries. */
  inner_lines: { depth: boolean; normal: boolean; parts: boolean };
  line_depth_threshold: number;
  line_side: 'near' | 'far';
  line_color: 'auto' | RGB;
  palette: PaletteMode;
  max_colors: number;
  dither: 'none' | 'bayer2' | 'bayer4' | 'bayer8';
  dither_strength: number;
  cleanup: 'none' | 'specks' | 'despeckle';
  pixel_perfect: boolean;
  alpha_bleed: boolean;
  background?: RGB;
}

export interface ProcessedFrame {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** View-space normal map (RGB = n*0.5+0.5), alpha = sprite alpha. */
  normal_rgba: Uint8ClampedArray;
  stats: {
    opaque_pixels: number;
    colors: number;
    outline_pixels: number;
    line_pixels: number;
    shade_levels_used: number[];
    palette_size?: number;
  };
}

// ───────────────────────────── shading ─────────────────────────────

/** Band thresholds on the Lambert term for n levels: [deep shadow, shadow, highlight, bright]. */
function bandLevel(lambert: number, levels: number): number {
  const n = Math.max(1, Math.min(5, Math.round(levels)));
  if (n === 1) return 0;
  if (n === 2) return lambert < 0.2 ? -1 : 0;
  if (n === 3) return lambert < 0.2 ? -1 : lambert >= 0.7 ? 1 : 0;
  if (n === 4) return lambert < -0.3 ? -2 : lambert < 0.2 ? -1 : lambert >= 0.7 ? 1 : 0;
  return lambert < -0.3 ? -2 : lambert < 0.2 ? -1 : lambert >= 0.95 ? 2 : lambert >= 0.7 ? 1 : 0;
}

/** The light direction converted into view space for a camera pitched by `pitch` degrees. */
export function lightInViewSpace(light: V3, pitch: number): V3 {
  const phi = (pitch * Math.PI) / 180;
  const c = Math.cos(phi), s = Math.sin(phi);
  // x = image right; y = world up = (0, cosφ, sinφ) in view space; z = horizontal toward camera = (0, −sinφ, cosφ)
  const x = light[0];
  const y = light[1] * c - light[2] * s;
  const z = light[1] * s + light[2] * c;
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

// ───────────────────────────── main ─────────────────────────────

export function processFrame(buf: PixelBuffers, style: StyleOptions, lightView: V3, sourceColors: RGB[] | null): ProcessedFrame {
  const { width: W, height: H } = buf;
  const N = W * H;
  const alpha = new Uint8Array(buf.alpha); // working copy (outline may grow it)
  const color = new Uint8ClampedArray(N * 3);
  const levelOf = new Int8Array(N);
  const levelsUsed = new Set<number>();
  const rampCache = new Map<string, RGB>();
  const shade = (rgb: RGB, level: number): RGB => {
    if (level === 0) return rgb;
    const key = `${rgbKey(rgb[0], rgb[1], rgb[2])}:${level}`;
    let out = rampCache.get(key);
    if (!out) { out = shadeColor(rgb, level, style.ramp); rampCache.set(key, out); }
    return out;
  };
  // Selective outline ("selout"): the darkest ramp tone pushed further down —
  // L×0.7 on the shadow side (bottom/right), a lighter L×0.88 on the lit
  // top/left edge — so the line always adds contrast but keeps the fill's hue.
  const outlineShade = (rgb: RGB, litSide: boolean): RGB => {
    const key = `${rgbKey(rgb[0], rgb[1], rgb[2])}:o${litSide ? 1 : 0}`;
    let out = rampCache.get(key);
    if (!out) { out = scaleLightness(shade(rgb, -2), litSide ? 0.88 : 0.7); rampCache.set(key, out); }
    return out;
  };

  // 1. Base colour per pixel.
  for (let p = 0; p < N; p++) {
    if (!alpha[p]) continue;
    const a: RGB = [buf.albedo[p * 3], buf.albedo[p * 3 + 1], buf.albedo[p * 3 + 2]];
    let out: RGB;
    if (style.shading === 'flat') {
      out = a;
    } else if (style.shading === 'blockbench') {
      out = [buf.lit[p * 3], buf.lit[p * 3 + 1], buf.lit[p * 3 + 2]];
    } else {
      const nx = buf.normal[p * 3], ny = buf.normal[p * 3 + 1], nz = buf.normal[p * 3 + 2];
      const lambert = nx * lightView[0] + ny * lightView[1] + nz * lightView[2];
      const level = bandLevel(lambert, style.shade_levels);
      levelOf[p] = level;
      levelsUsed.add(level);
      out = shade(a, level);
    }
    color[p * 3] = out[0]; color[p * 3 + 1] = out[1]; color[p * 3 + 2] = out[2];
  }

  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x);
  const opaque = (x: number, y: number) => { const i = at(x, y); return i >= 0 && alpha[i] > 0; };
  const getColor = (p: number): RGB => [color[p * 3], color[p * 3 + 1], color[p * 3 + 2]];
  const setColor = (p: number, c: RGB) => { color[p * 3] = c[0]; color[p * 3 + 1] = c[1]; color[p * 3 + 2] = c[2]; };

  // 2. Inner lines from depth steps, normal creases and part boundaries.
  let linePixels = 0;
  const isLine = new Uint8Array(N);
  const wantLines = style.inner_lines.depth || style.inner_lines.normal || style.inner_lines.parts;
  if (wantLines) {
    const thr = Math.max(1e-4, style.line_depth_threshold);
    const eps = Math.max(0.05, thr * 0.25);
    const lightDot = (p: number) => buf.normal[p * 3] * lightView[0] + buf.normal[p * 3 + 1] * lightView[1] + buf.normal[p * 3 + 2] * lightView[2];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = at(x, y);
        if (!alpha[p]) continue;
        let line = false;
        const d = buf.depth[p];
        for (const [ax, ay] of [[1, 0], [0, 1]] as [number, number][]) {
          const pa = at(x - ax, y - ay), pb = at(x + ax, y + ay);
          if (style.inner_lines.parts) {
            // A different bone next to this pixel: line on the farther side, or —
            // when flush — on the bottom/right side (the shadow side).
            for (const q of [pa, pb]) {
              if (q < 0 || !alpha[q] || !buf.part[q] || !buf.part[p] || buf.part[q] === buf.part[p]) continue;
              const dd = d - buf.depth[q];
              const farther = dd > eps;
              const flushShadowSide = Math.abs(dd) <= eps && q === pa; // q is above/left of p
              if (style.line_side === 'near' ? (dd < -eps || flushShadowSide) : (farther || flushShadowSide)) { line = true; break; }
            }
            if (line) break;
          }
          if (pa < 0 || pb < 0 || !alpha[pa] || !alpha[pb]) continue;
          if (style.inner_lines.depth) {
            // Second difference: flat slopes give 0, a silhouette step gives half the jump.
            const dev = d - (buf.depth[pa] + buf.depth[pb]) / 2;
            if (style.line_side === 'near' ? dev < -thr : dev > thr) { line = true; break; }
          }
          if (style.inner_lines.normal) {
            for (const q of [pa, pb]) {
              const cos = buf.normal[p * 3] * buf.normal[q * 3] + buf.normal[p * 3 + 1] * buf.normal[q * 3 + 1] + buf.normal[p * 3 + 2] * buf.normal[q * 3 + 2];
              if (cos < 0.5 && lightDot(p) < lightDot(q) - 0.05) { line = true; break; }
            }
            if (line) break;
          }
        }
        if (line) isLine[p] = 1;
      }
    }
    for (let p = 0; p < N; p++) {
      if (!isLine[p]) continue;
      linePixels++;
      if (style.line_color === 'auto') setColor(p, shade(getColor(p), -1));
      else setColor(p, style.line_color);
    }
  }

  // 3. Outline.
  let outlinePixels = 0;
  const isOutline = new Uint8Array(N);
  if (style.outline !== 'none') {
    const neighbours4: [number, number][] = [[0, 1], [1, 0], [-1, 0], [0, -1]];
    const neighbours8: [number, number][] = [...neighbours4, [1, 1], [-1, 1], [1, -1], [-1, -1]];
    const conn = style.outline_connectivity === 8 ? neighbours8 : neighbours4;
    const additions: { p: number; c: RGB }[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = at(x, y);
        if (style.outline === 'outer') {
          if (alpha[p]) continue;
          // Prefer the fill pixel below/right (shadow-side rule), then any.
          let fill = -1, litSide = false;
          for (const [dx, dy] of conn) {
            const q = at(x + dx, y + dy);
            if (q >= 0 && alpha[q] && !isOutline[q]) {
              const thisLit = dy > 0 || (dy === 0 && dx > 0); // fill is below or right → outline sits on the lit top/left edge
              if (fill < 0 || (thisLit && !litSide)) { fill = q; litSide = thisLit; }
            }
          }
          if (fill < 0) continue;
          const c: RGB = style.outline_color === 'auto' ? outlineShade(getColor(fill), litSide) : style.outline_color;
          additions.push({ p, c });
        } else {
          if (!alpha[p]) continue;
          let edge = false, litSide = false;
          for (const [dx, dy] of conn) {
            const q = at(x + dx, y + dy);
            if (q < 0 || !alpha[q]) {
              edge = true;
              if (dy < 0 || (dy === 0 && dx < 0)) litSide = true; // background above/left → lit edge
            }
          }
          if (!edge) continue;
          const c: RGB = style.outline_color === 'auto' ? outlineShade(getColor(p), litSide) : style.outline_color;
          additions.push({ p, c });
        }
      }
    }
    for (const add of additions) {
      alpha[add.p] = 255;
      isOutline[add.p] = 1;
      setColor(add.p, add.c);
      outlinePixels++;
    }
  }

  // 4. Palette.
  let paletteSize: number | undefined;
  if (style.palette !== 'none') {
    let matcher: PaletteMatcher | null = null;
    let dither = style.dither;
    if (style.palette === 'source') {
      const base = sourceColors && sourceColors.length ? sourceColors : uniqueColors(color, alpha, N);
      const candidates: RGB[] = [];
      const levels = style.shading === 'toon' ? [-3, -2, -1, 0, 1, 2] : [-3, -2, -1, 0];
      for (const c of base) {
        for (const l of levels) candidates.push(shade(c, l));
        candidates.push(outlineShade(c, true), outlineShade(c, false));
      }
      if (style.shading === 'blockbench') {
        for (const c of base) for (const f of [0.8, 0.6, 0.5]) candidates.push([Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)]);
      }
      if (style.outline_color !== 'auto') candidates.push(style.outline_color);
      if (style.line_color !== 'auto') candidates.push(style.line_color);
      matcher = new PaletteMatcher(candidates);
      dither = 'none'; // snapping to the model's own colours never needs dither
    } else if (style.palette === 'auto') {
      const hist = new Map<number, number>();
      for (let p = 0; p < N; p++) if (alpha[p]) { const k = rgbKey(color[p * 3], color[p * 3 + 1], color[p * 3 + 2]); hist.set(k, (hist.get(k) || 0) + 1); }
      matcher = new PaletteMatcher(quantizeColors(hist, Math.max(2, Math.round(style.max_colors))));
    } else if (Array.isArray(style.palette) && style.palette.length) {
      matcher = new PaletteMatcher(style.palette);
    }
    if (matcher) {
      paletteSize = matcher.size;
      const spread = dither === 'none' ? 0 : paletteSpread(matcher.rgb) * Math.max(0, Math.min(1, style.dither_strength));
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x;
          if (!alpha[p]) continue;
          let r = color[p * 3], g = color[p * 3 + 1], b = color[p * 3 + 2];
          if (spread > 0 && !isOutline[p]) { // never dither an outline
            const t = bayerThreshold(dither as 'bayer2' | 'bayer4' | 'bayer8', x, y) * spread;
            r = clamp255(r + t); g = clamp255(g + t); b = clamp255(b + t);
          }
          setColor(p, matcher.nearest(r, g, b));
        }
      }
    }
  }

  // 5. Cleanup.
  if (style.cleanup !== 'none') {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = at(x, y);
        if (!alpha[p]) continue;
        let opaqueNeighbours = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && opaque(x + dx, y + dy)) opaqueNeighbours++;
        if (opaqueNeighbours === 0) { alpha[p] = 0; continue; } // floating speck
        if (style.cleanup === 'despeckle' && !isOutline[p] && !isLine[p]) {
          const own = rgbKey(color[p * 3], color[p * 3 + 1], color[p * 3 + 2]);
          const votes = new Map<number, number>();
          let same = false;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const q = at(x + dx, y + dy);
            if (q < 0 || !alpha[q]) continue;
            const k = rgbKey(color[q * 3], color[q * 3 + 1], color[q * 3 + 2]);
            if (k === own) { same = true; break; }
            votes.set(k, (votes.get(k) || 0) + 1);
          }
          if (!same && votes.size) {
            let bestK = own, bestN = 0;
            for (const [k, n] of votes) if (n > bestN) { bestN = n; bestK = k; }
            setColor(p, keyToRgb(bestK));
          }
        }
      }
    }
  }
  if (style.pixel_perfect && outlinePixels) {
    // Aseprite's rule on the outline only: drop the middle pixel of an L-shaped
    // corner of a 1 px line so diagonals connect corner-to-corner.
    const remove: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = at(x, y);
        if (!alpha[p] || !isOutline[p]) continue;
        const h = [opaque(x - 1, y) ? -1 : 0, opaque(x + 1, y) ? 1 : 0].filter(Boolean);
        const v = [opaque(x, y - 1) ? -1 : 0, opaque(x, y + 1) ? 1 : 0].filter(Boolean);
        if (h.length !== 1 || v.length !== 1) continue;
        const dx = h[0], dy = v[0];
        if (opaque(x + dx, y + dy)) continue;            // corner of a filled block
        let others = 0;
        for (const [ox, oy] of [[-dx, -dy], [-dx, dy], [dx, -dy]]) if (opaque(x + ox, y + oy)) others++;
        if (others) continue;
        remove.push(p);
      }
    }
    for (const p of remove) alpha[p] = 0;
  }

  // 6. Assemble RGBA (+ alpha bleed, background).
  const rgba = new Uint8ClampedArray(N * 4);
  let opaqueCount = 0;
  const colorsUsed = new Set<number>();
  for (let p = 0; p < N; p++) {
    if (alpha[p]) {
      rgba[p * 4] = color[p * 3]; rgba[p * 4 + 1] = color[p * 3 + 1]; rgba[p * 4 + 2] = color[p * 3 + 2]; rgba[p * 4 + 3] = 255;
      opaqueCount++;
      colorsUsed.add(rgbKey(color[p * 3], color[p * 3 + 1], color[p * 3 + 2]));
    }
  }
  if (style.background) {
    for (let p = 0; p < N; p++) {
      if (!alpha[p]) { rgba[p * 4] = style.background[0]; rgba[p * 4 + 1] = style.background[1]; rgba[p * 4 + 2] = style.background[2]; rgba[p * 4 + 3] = 255; }
    }
  } else if (style.alpha_bleed) {
    alphaBleed(rgba, W, H, 6);
  }

  // Normal map (view space), useful for engines that light sprites (Dead Cells style).
  const normalRgba = new Uint8ClampedArray(N * 4);
  for (let p = 0; p < N; p++) {
    if (!alpha[p]) continue;
    // Outline / grown pixels have no geometry: point them at the camera.
    const hasGeo = buf.alpha[p] > 0;
    const nx = hasGeo ? buf.normal[p * 3] : 0, ny = hasGeo ? buf.normal[p * 3 + 1] : 0, nz = hasGeo ? buf.normal[p * 3 + 2] : 1;
    normalRgba[p * 4] = Math.round((nx * 0.5 + 0.5) * 255);
    normalRgba[p * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    normalRgba[p * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    normalRgba[p * 4 + 3] = 255;
  }

  return {
    width: W, height: H, rgba, normal_rgba: normalRgba,
    stats: {
      opaque_pixels: opaqueCount,
      colors: colorsUsed.size,
      outline_pixels: outlinePixels,
      line_pixels: linePixels,
      shade_levels_used: [...levelsUsed].sort((a, b) => a - b),
      palette_size: paletteSize,
    },
  };
}

// ───────────────────────────── helpers ─────────────────────────────

function clamp255(v: number): number { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

function uniqueColors(color: Uint8ClampedArray, alpha: Uint8Array, N: number): RGB[] {
  const seen = new Set<number>();
  const out: RGB[] = [];
  for (let p = 0; p < N; p++) {
    if (!alpha[p]) continue;
    const k = rgbKey(color[p * 3], color[p * 3 + 1], color[p * 3 + 2]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(keyToRgb(k));
  }
  return out;
}

/** Typical gap between neighbouring palette colours (RGB units) — the dither amplitude. */
function paletteSpread(palette: RGB[]): number {
  if (palette.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 0; i < palette.length; i++) {
    let best = Infinity;
    for (let j = 0; j < palette.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(palette[i][0] - palette[j][0], palette[i][1] - palette[j][1], palette[i][2] - palette[j][2]);
      if (d < best) best = d;
    }
    gaps.push(best);
  }
  gaps.sort((a, b) => a - b);
  return Math.max(8, Math.min(96, gaps[Math.floor(gaps.length / 2)]));
}

/** Copy nearby opaque colours into transparent pixels (alpha stays 0). */
function alphaBleed(rgba: Uint8ClampedArray, W: number, H: number, passes: number) {
  const filled = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) filled[p] = rgba[p * 4 + 3] ? 1 : 0;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(filled);
    let changed = false;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (filled[p]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const q = yy * W + xx;
            if (!filled[q]) continue;
            r += rgba[q * 4]; g += rgba[q * 4 + 1]; b += rgba[q * 4 + 2]; n++;
          }
        }
        if (!n) continue;
        rgba[p * 4] = Math.round(r / n); rgba[p * 4 + 1] = Math.round(g / n); rgba[p * 4 + 2] = Math.round(b / n);
        next[p] = 1;
        changed = true;
      }
    }
    filled.set(next);
    if (!changed) break;
  }
}

/** Distinct opaque colours of the project's textures (the model's own palette). */
export function collectTextureColors(maxColors = 4096): { colors: RGB[]; truncated: boolean } {
  const seen = new Set<number>();
  const out: RGB[] = [];
  let truncated = false;
  for (const tex of Texture.all) {
    try {
      const canvas = tex.canvas;
      const w = canvas?.width, h = canvas?.height;
      if (!w || !h) continue;
      const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const k = rgbKey(data[i], data[i + 1], data[i + 2]);
        if (seen.has(k)) continue;
        if (out.length >= maxColors) { truncated = true; break; }
        seen.add(k);
        out.push([data[i], data[i + 1], data[i + 2]]);
      }
    } catch { /* texture without a bitmap */ }
    if (truncated) break;
  }
  return { colors: out, truncated };
}

/** Horizontal flip of an RGBA buffer (for mirrored directions). */
export function flipHorizontal(rgba: Uint8ClampedArray, W: number, H: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4, d = (y * W + (W - 1 - x)) * 4;
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
    }
  }
  return out;
}

/** Mirroring a view-space normal map flips the x component too. */
export function flipNormalMap(rgba: Uint8ClampedArray, W: number, H: number): Uint8ClampedArray {
  const out = flipHorizontal(rgba, W, H);
  for (let p = 0; p < W * H; p++) if (out[p * 4 + 3]) out[p * 4] = 255 - out[p * 4];
  return out;
}
