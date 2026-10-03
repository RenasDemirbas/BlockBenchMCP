// palette: hue-shifted colour ramps, palette extraction, and locking a
// texture to a limited palette — the colour discipline of pixel-art textures.
import { register, fail, requireProject } from '../registry';
import { resolveTexture, clampInt } from '../util';
import {
  RGB, parseHex, toHex, rgbKey, shadeColor, rampOptions, PALETTES, paletteNames, PaletteMatcher, quantizeColors, bayerThreshold,
} from '../pixelart/color';
import { paintTarget, commitBitmap } from './layers';

function parseColor(c: string, label: string): RGB {
  const rgb = parseHex(String(c));
  if (!rgb) fail(`${label}: "${c}" is not a hex colour like "#7a3a32".`);
  return rgb!;
}

/** Ramp around a base colour: shadows (dark → base) then highlights. */
function buildRamp(base: RGB, down: number, up: number, opts: any): RGB[] {
  const ramp: RGB[] = [];
  for (let l = -down; l <= up; l++) ramp.push(shadeColor(base, l, opts));
  return ramp;
}

/** A swatch strip image: one row per ramp. */
function swatch(rows: RGB[][], cell = 16): string {
  const w = Math.max(...rows.map((r) => r.length)) * cell, h = rows.length * cell;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  rows.forEach((row, y) => row.forEach((c, x) => { ctx.fillStyle = toHex(c); ctx.fillRect(x * cell, y * cell, cell, cell); }));
  return canvas.toDataURL('image/png');
}

function histogramOf(data: Uint8ClampedArray): Map<number, number> {
  const h = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const k = rgbKey(data[i], data[i + 1], data[i + 2]);
    h.set(k, (h.get(k) || 0) + 1);
  }
  return h;
}

register('palette', (params) => {
  requireProject();
  const action = params.action;
  const ramp = rampOptions(params.ramp);

  if (action === 'ramp') {
    const bases: string[] = Array.isArray(params.colors) ? params.colors : (params.color ? [params.color] : []);
    if (!bases.length) fail('Pass "colors": ["#hex", ...] — one ramp is built per base colour.');
    const down = clampInt(params.shadows ?? 2, 0, 5), up = clampInt(params.highlights ?? 2, 0, 4);
    const rows = bases.map((c, i) => buildRamp(parseColor(c, `colors[${i}]`), down, up, ramp));
    return {
      ramps: bases.map((c, i) => ({ base: c, colors: rows[i].map(toHex), base_index: down })),
      all: [...new Set(rows.flat().map(toHex))],
      note: 'Each ramp runs darkest → lightest; base_index is the base colour. Use the hexes in paint_faces / paint_texture, or lock a texture to them with action "quantize".',
      __image: swatch(rows),
    };
  }

  const texture = resolveTexture(params.texture);
  const target = paintTarget(texture, params.layer);
  const img = target.ctx.getImageData(0, 0, target.canvas.width, target.canvas.height);

  if (action === 'extract') {
    const hist = histogramOf(img.data);
    const sorted = [...hist.entries()].sort((a, b) => b[1] - a[1]);
    const max = clampInt(params.max_colors ?? 32, 1, 256);
    const reduced = sorted.length > max ? quantizeColors(hist, max) : sorted.map(([k]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255] as RGB);
    return {
      unique_colors: hist.size,
      top: sorted.slice(0, 24).map(([k, n]) => ({ color: toHex([(k >> 16) & 255, (k >> 8) & 255, k & 255]), pixels: n })),
      palette: reduced.map(toHex),
      __image: swatch([reduced]),
    };
  }

  if (action === 'quantize') {
    // Target palette: explicit list, a built-in, ramps generated from base
    // colours, or "auto" (median cut over the texture's own colours).
    let colors: RGB[];
    const p = params.palette ?? 'auto';
    if (Array.isArray(p)) colors = p.map((c: string, i: number) => parseColor(c, `palette[${i}]`));
    else if (p === 'auto') colors = quantizeColors(histogramOf(img.data), clampInt(params.max_colors ?? 24, 2, 256));
    else if (p === 'ramps') {
      const bases: string[] = params.colors || [];
      if (!bases.length) fail('palette "ramps" needs "colors": base colours to build ramps from.');
      colors = bases.flatMap((c, i) => buildRamp(parseColor(c, `colors[${i}]`), clampInt(params.shadows ?? 3, 0, 5), clampInt(params.highlights ?? 2, 0, 4), ramp));
    } else if (PALETTES[p]) colors = PALETTES[p].colors.map((c) => parseHex(c)!);
    else fail(`Unknown palette "${p}". Use an array of hex colours, "auto", "ramps", or one of: ${paletteNames().join(', ')}.`);
    const matcher = new PaletteMatcher(colors);
    const dither = params.dither && params.dither !== 'none' ? params.dither : null;
    const strength = params.dither_strength ?? 0.5;
    const before = histogramOf(img.data).size;
    Undo.initEdit({ textures: [texture], bitmap: true });
    try {
      const d = img.data, W = img.width;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        let r = d[i], g = d[i + 1], b = d[i + 2];
        if (dither) {
          const px = (i / 4) % W, py = Math.floor(i / 4 / W);
          const t = bayerThreshold(dither, px, py) * strength * 48;
          r = Math.max(0, Math.min(255, r + t)); g = Math.max(0, Math.min(255, g + t)); b = Math.max(0, Math.min(255, b + t));
        }
        const c = matcher.nearest(r, g, b);
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
        if (params.binary_alpha !== false) d[i + 3] = d[i + 3] >= 128 ? 255 : 0;
      }
      target.ctx.putImageData(img, 0, 0);
      commitBitmap(texture);
    } catch (err) {
      Undo.cancelEdit(true);
      throw err;
    }
    Undo.finishEdit('MCP: Quantize texture', { textures: [texture], bitmap: true });
    UVEditor.vue?.updateTextureCanvas?.();
    return {
      texture: texture.name,
      layer: target.layer?.name,
      colors_before: before,
      colors_after: histogramOf(img.data).size,
      palette_size: matcher.size,
      palette: matcher.rgb.map(toHex),
      __image: swatch([matcher.rgb]),
    };
  }

  fail('"action" must be ramp, extract or quantize.');
});
