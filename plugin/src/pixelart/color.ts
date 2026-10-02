// Colour science for the pixel-art exporter: sRGB <-> Oklab/OKLCH, perceptual
// nearest-colour lookup, hue-shifted shade ramps, palette quantisation and
// ordered dithering. Everything works on plain numbers so it can run inside
// Blockbench's renderer without touching the DOM.

export type RGB = [number, number, number];
export type Lab = [number, number, number];   // Oklab L, a, b
export type LCH = [number, number, number];   // Oklab L, C, h(deg)

// ───────────────────────────── sRGB <-> Oklab ─────────────────────────────

function srgbToLinear(c: number): number {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

export function rgbToOklab(r: number, g: number, b: number): Lab {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** Oklab -> linear sRGB (unclamped, may leave [0,1] when out of gamut). */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function inGamut(lin: [number, number, number]): boolean {
  return lin.every((v) => v >= -0.0005 && v <= 1.0005);
}

export function oklabToRgb(L: number, a: number, b: number): RGB {
  let lin = oklabToLinear(L, a, b);
  if (!inGamut(lin)) {
    // Gamut-map by shrinking chroma toward the achromatic axis (keeps hue and
    // lightness, which is what a shade ramp wants).
    let lo = 0, hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear(L, a * mid, b * mid))) lo = mid; else hi = mid;
    }
    lin = oklabToLinear(L, a * lo, b * lo);
  }
  return [linearToSrgb(Math.max(0, Math.min(1, lin[0]))), linearToSrgb(Math.max(0, Math.min(1, lin[1]))), linearToSrgb(Math.max(0, Math.min(1, lin[2])))];
}

export function labToLch(lab: Lab): LCH {
  const C = Math.hypot(lab[1], lab[2]);
  let h = Math.atan2(lab[2], lab[1]) * 180 / Math.PI;
  if (h < 0) h += 360;
  return [lab[0], C, h];
}

export function lchToLab(lch: LCH): Lab {
  const rad = lch[2] * Math.PI / 180;
  return [lch[0], lch[1] * Math.cos(rad), lch[1] * Math.sin(rad)];
}

/** Squared perceptual distance in Oklab (uniform enough for nearest lookups). */
export function labDistanceSq(a: Lab, b: Lab): number {
  const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}

// ───────────────────────────── hex helpers ─────────────────────────────

export function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(hex).trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex(rgb: RGB): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

export function rgbKey(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

export function keyToRgb(key: number): RGB {
  return [(key >> 16) & 255, (key >> 8) & 255, key & 255];
}

// ───────────────────────────── shade ramps ─────────────────────────────

export interface RampOptions {
  /** Lightness change per step in Oklab L (0..1). Default 0.13 (≈ −0.13 / −0.24 for two shadow steps). */
  step?: number;
  /** Degrees of hue rotation per step toward the target hue. Default 15. */
  hue_shift?: number;
  /** Hue that shadows drift toward (default 270 = blue-violet). */
  shadow_hue?: number;
  /** Hue that highlights drift toward (default 90 = warm yellow). */
  highlight_hue?: number;
  /** Oklab chroma ADDED per shadow step (default 0.02) and REMOVED per highlight step (default 0.03). */
  shadow_chroma?: number;
  highlight_chroma?: number;
}

// Numbers follow the common pixel-art ramp recipe (Slynyrd / saint11 /
// Pixel Parmesan): shadow₁ ≈ L−0.15, C+0.02, 15° toward 270°; shadow₂ ≈
// L−0.25, C+0.03..0.05, 25–30° toward 270°; highlight ≈ L+0.15, C−0.03,
// 15–20° toward 90°.
const DEFAULT_RAMP: Required<RampOptions> = {
  step: 0.13,
  hue_shift: 15,
  shadow_hue: 270,
  highlight_hue: 90,
  shadow_chroma: 0.02,
  highlight_chroma: 0.03,
};

export function rampOptions(partial?: RampOptions): Required<RampOptions> {
  return { ...DEFAULT_RAMP, ...(partial || {}) };
}

/** Signed shortest rotation from hue a toward hue b, capped at maxDeg. */
function hueToward(a: number, b: number, maxDeg: number): number {
  let d = ((b - a + 540) % 360) - 180;
  if (d > maxDeg) d = maxDeg;
  if (d < -maxDeg) d = -maxDeg;
  return a + d;
}

/**
 * The pixel-art shading rule: shadows get darker AND cooler AND a touch more
 * saturated; highlights get lighter, warmer and less saturated. `level` is
 * the number of steps: negative = shadow, positive = highlight, 0 = base.
 * Near-achromatic colours keep their (lack of) hue instead of turning purple.
 */
export function shadeColor(rgb: RGB, level: number, opts: Required<RampOptions>): RGB {
  if (level === 0) return rgb;
  const lab = rgbToOklab(rgb[0], rgb[1], rgb[2]);
  let [L, C, h] = labToLch(lab);
  const steps = Math.abs(level);
  const chromatic = C > 0.015; // greys stay grey instead of turning purple
  for (let i = 0; i < steps; i++) {
    const falloff = 1 - 0.2 * i; // diminishing steps keep deep shadows readable
    if (level < 0) {
      L -= opts.step * falloff;
      if (chromatic) {
        h = hueToward(h, opts.shadow_hue, opts.hue_shift);
        // A touch more chroma, but capped: saturated blues/greens go neon when
        // pushed further in the dark, which no pixel artist would do.
        C = Math.min(C + opts.shadow_chroma * falloff, Math.max(C, 0.14));
      }
    } else {
      L += opts.step * 0.9 * falloff;
      if (chromatic) {
        h = hueToward(h, opts.highlight_hue, opts.hue_shift);
        C = Math.max(0, C * 0.9 - opts.highlight_chroma * 0.5);
      }
    }
  }
  L = Math.max(0.03, Math.min(0.99, L));
  const out = lchToLab([L, C, h]);
  return oklabToRgb(out[0], out[1], out[2]);
}

/** Scale Oklab lightness (keeps hue and chroma) — used to push outlines below the ramp. */
export function scaleLightness(rgb: RGB, factor: number): RGB {
  const lab = rgbToOklab(rgb[0], rgb[1], rgb[2]);
  const L = Math.max(0.02, Math.min(0.99, lab[0] * factor));
  return oklabToRgb(L, lab[1], lab[2]);
}

// ───────────────────────────── palettes ─────────────────────────────

export const PALETTES: Record<string, { name: string; colors: string[] }> = {
  pico8: {
    name: 'PICO-8 (16)',
    colors: ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'],
  },
  sweetie16: {
    name: 'Sweetie 16',
    colors: ['#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179', '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57'],
  },
  endesga32: {
    name: 'Endesga 32',
    colors: ['#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39', '#3e2731', '#a22633', '#e43b44', '#f77622', '#feae34', '#fee761', '#63c74d', '#3e8948', '#265c42', '#193c3e', '#124e89', '#0099db', '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466', '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a', '#e8b796', '#c28569'],
  },
  db32: {
    name: 'DawnBringer 32',
    colors: ['#000000', '#222034', '#45283c', '#663931', '#8f563b', '#df7126', '#d9a066', '#eec39a', '#fbf236', '#99e550', '#6abe30', '#37946e', '#4b692f', '#524b24', '#323c39', '#3f3f74', '#306082', '#5b6ee1', '#639bff', '#5fcde4', '#cbdbfc', '#ffffff', '#9badb7', '#847e87', '#696a6a', '#595652', '#76428a', '#ac3232', '#d95763', '#d77bba', '#8f974a', '#8a6f30'],
  },
  aap64: {
    name: 'AAP-64',
    colors: ['#060608', '#141013', '#3b1725', '#73172d', '#b4202a', '#df3e23', '#fa6a0a', '#f9a31b', '#ffd541', '#fffc40', '#d6f264', '#9cdb43', '#59c135', '#14a02e', '#1a7a3e', '#24523b', '#122020', '#143464', '#285cc4', '#249fde', '#20d6c7', '#a6fcdb', '#ffffff', '#fef3c0', '#fad6b8', '#f5a097', '#e86a73', '#bc4a9b', '#793a80', '#403353', '#242234', '#221c1a', '#322b28', '#71413b', '#bb7547', '#dba463', '#f4d29c', '#dae0ea', '#b3b9d1', '#8b93af', '#6d758d', '#4a5462', '#333941', '#422433', '#5b3138', '#8e5252', '#ba756a', '#e9b5a3', '#e3e6ff', '#b9bffb', '#849be4', '#588dbe', '#477d85', '#23674e', '#328464', '#5daf8d', '#92dcba', '#cdf7e2', '#e4d2aa', '#c7b08b', '#a08662', '#796755', '#5a4e44', '#423934'],
  },
  resurrect64: {
    name: 'Resurrect 64',
    colors: ['#2e222f', '#3e3546', '#625565', '#966c6c', '#ab947a', '#694f62', '#7f708a', '#9babb2', '#c7dcd0', '#ffffff', '#6e2727', '#b33831', '#ea4f36', '#f57d4a', '#ae2334', '#e83b3b', '#fb6b1d', '#f79617', '#f9c22b', '#7a3045', '#9e4539', '#cd683d', '#e6904e', '#fbb954', '#4c3e24', '#676633', '#a2a947', '#d5e04b', '#fbff86', '#165a4c', '#239063', '#1ebc73', '#91db69', '#cddf6c', '#313638', '#374e4a', '#547e64', '#92a984', '#b2ba90', '#0b5e65', '#0b8a8f', '#0eaf9b', '#30e1b9', '#8ff8e2', '#323353', '#484a77', '#4d65b4', '#4d9be6', '#8fd3ff', '#45293f', '#6b3e75', '#905ea9', '#a884f3', '#eaaded', '#753c54', '#a24b6f', '#cf657f', '#ed8099', '#831c5d', '#c32454', '#f04f78', '#f68181', '#fca790', '#fdcbb0'],
  },
  apollo: {
    name: 'Apollo (46)',
    colors: ['#172038', '#253a5e', '#3c5e8b', '#4f8fba', '#73bed3', '#a4dddb', '#19332d', '#25562e', '#468232', '#75a743', '#a8ca58', '#d0da91', '#4d2b32', '#7a4841', '#ad7757', '#c09473', '#d7b594', '#e7d5b3', '#341c27', '#602c2c', '#884b2b', '#be772b', '#de9e41', '#e8c170', '#241527', '#411d31', '#752438', '#a53030', '#cf573c', '#da863e', '#1e1d39', '#402751', '#7a367b', '#a23e8c', '#c65197', '#df84a5', '#090a14', '#10141f', '#151d28', '#202e37', '#394a50', '#577277', '#819796', '#a8b5b2', '#c7cfcc', '#ebede9'],
  },
};

export function paletteNames(): string[] {
  return Object.keys(PALETTES);
}

// ───────────────────────────── nearest lookup ─────────────────────────────

export class PaletteMatcher {
  readonly rgb: RGB[];
  private lab: Lab[];
  private cache = new Map<number, number>();

  constructor(colors: RGB[]) {
    // Dedupe while keeping order.
    const seen = new Set<number>();
    this.rgb = [];
    for (const c of colors) {
      const k = rgbKey(c[0], c[1], c[2]);
      if (seen.has(k)) continue;
      seen.add(k);
      this.rgb.push([c[0], c[1], c[2]]);
    }
    this.lab = this.rgb.map((c) => rgbToOklab(c[0], c[1], c[2]));
  }

  get size(): number { return this.rgb.length; }

  /** Index of the perceptually nearest palette entry. */
  nearestIndex(r: number, g: number, b: number): number {
    const key = rgbKey(r, g, b);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const lab = rgbToOklab(r, g, b);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.lab.length; i++) {
      const d = labDistanceSq(lab, this.lab[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.cache.set(key, best);
    return best;
  }

  nearest(r: number, g: number, b: number): RGB {
    return this.rgb[this.nearestIndex(r, g, b)];
  }
}

// ───────────────────────────── quantisation ─────────────────────────────

/**
 * Median cut in Oklab followed by a few k-means refinements — good enough for
 * sprites (at most a few thousand opaque pixels) and deterministic. Input is
 * a histogram: key -> count.
 */
export function quantizeColors(histogram: Map<number, number>, maxColors: number): RGB[] {
  const entries = [...histogram.entries()].map(([key, count]) => {
    const rgb = keyToRgb(key);
    return { rgb, lab: rgbToOklab(rgb[0], rgb[1], rgb[2]), count };
  });
  if (entries.length <= maxColors) return entries.map((e) => e.rgb);

  type Box = { items: typeof entries };
  const boxes: Box[] = [{ items: entries }];
  const range = (items: typeof entries, axis: number) => {
    let lo = Infinity, hi = -Infinity;
    for (const it of items) { if (it.lab[axis] < lo) lo = it.lab[axis]; if (it.lab[axis] > hi) hi = it.lab[axis]; }
    return hi - lo;
  };
  while (boxes.length < maxColors) {
    // Split the box with the largest (weighted) spread.
    let bi = -1, bestSpread = -1;
    boxes.forEach((box, i) => {
      if (box.items.length < 2) return;
      const spread = Math.max(range(box.items, 0), range(box.items, 1), range(box.items, 2)) * Math.sqrt(box.items.reduce((s, it) => s + it.count, 0));
      if (spread > bestSpread) { bestSpread = spread; bi = i; }
    });
    if (bi < 0) break;
    const box = boxes[bi];
    const axis = [0, 1, 2].reduce((a, b) => (range(box.items, a) >= range(box.items, b) ? a : b));
    box.items.sort((p, q) => p.lab[axis] - q.lab[axis]);
    const total = box.items.reduce((s, it) => s + it.count, 0);
    let acc = 0, cut = 0;
    for (let i = 0; i < box.items.length - 1; i++) {
      acc += box.items[i].count;
      if (acc >= total / 2) { cut = i + 1; break; }
    }
    if (cut === 0) cut = Math.floor(box.items.length / 2);
    boxes.splice(bi, 1, { items: box.items.slice(0, cut) }, { items: box.items.slice(cut) });
  }

  // Weighted centroids, then k-means refinement.
  let centers: Lab[] = boxes.map((box) => centroid(box.items));
  for (let iter = 0; iter < 6; iter++) {
    const sums: { l: number; a: number; b: number; n: number }[] = centers.map(() => ({ l: 0, a: 0, b: 0, n: 0 }));
    for (const it of entries) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < centers.length; i++) {
        const d = labDistanceSq(it.lab, centers[i]);
        if (d < bestD) { bestD = d; best = i; }
      }
      const s = sums[best];
      s.l += it.lab[0] * it.count; s.a += it.lab[1] * it.count; s.b += it.lab[2] * it.count; s.n += it.count;
    }
    centers = sums.map((s, i) => (s.n ? [s.l / s.n, s.a / s.n, s.b / s.n] as Lab : centers[i]));
  }
  // Snap each centre to the nearest actually-present colour so the palette
  // stays made of "real" colours (sprites look wrong with invented tints).
  const out: RGB[] = [];
  const used = new Set<number>();
  for (const c of centers) {
    let best = entries[0], bestD = Infinity;
    for (const it of entries) {
      const d = labDistanceSq(it.lab, c);
      if (d < bestD) { bestD = d; best = it; }
    }
    const k = rgbKey(best.rgb[0], best.rgb[1], best.rgb[2]);
    if (!used.has(k)) { used.add(k); out.push(best.rgb); }
  }
  return out;
}

function centroid(items: { lab: Lab; count: number }[]): Lab {
  let l = 0, a = 0, b = 0, n = 0;
  for (const it of items) { l += it.lab[0] * it.count; a += it.lab[1] * it.count; b += it.lab[2] * it.count; n += it.count; }
  return n ? [l / n, a / n, b / n] : [0, 0, 0];
}

// ───────────────────────────── ordered dithering ─────────────────────────────

const BAYER2 = [[0, 2], [3, 1]];
const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25], [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
];

/** Threshold in -0.5..0.5 for an ordered-dither matrix at pixel (x, y). */
export function bayerThreshold(kind: 'bayer2' | 'bayer4' | 'bayer8', x: number, y: number): number {
  const m = kind === 'bayer2' ? BAYER2 : kind === 'bayer4' ? BAYER4 : BAYER8;
  const n = m.length;
  return (m[y % n][x % n] + 0.5) / (n * n) - 0.5;
}
