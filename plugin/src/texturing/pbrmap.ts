// PBR map generation from a colour texture — the same per-pixel math as
// Blockbench 5.2's "Generate PBR Map" dialog, as pure functions so it runs
// without the dialog. A "method" reads one value per pixel, in_range/out_range
// remap it, and the channel decides how it is written:
//   height     greyscale
//   normal     tangent-space normal from the value's slope (R/G), B = 255
//   metalness  → red   of the MER texture
//   emissive   → green of the MER texture
//   roughness  → blue  of the MER texture

export type PbrChannel = 'height' | 'normal' | 'metalness' | 'emissive' | 'roughness';
export type PbrMethod = 'value' | 'brightness' | 'saturation' | 'hue' | 'red' | 'green' | 'blue' | 'empty';

export const PBR_CHANNELS: PbrChannel[] = ['height', 'normal', 'metalness', 'emissive', 'roughness'];
export const PBR_METHODS: PbrMethod[] = ['value', 'brightness', 'saturation', 'hue', 'red', 'green', 'blue', 'empty'];

/** Index of a MER channel in RGBA; height/normal get their own texture. */
export const MER_INDEX: Partial<Record<PbrChannel, number>> = { metalness: 0, emissive: 1, roughness: 2 };

/** Which texture pbr_channel a generated map lands in. */
export const textureChannelOf = (c: PbrChannel) => (c === 'height' || c === 'normal' ? c : 'mer');

export interface PbrSettings {
  method: PbrMethod;
  in_range: [number, number];
  out_range: [number, number];
  invert: boolean;
  /** normal only: slope multiplier (1 = Blockbench's own). */
  strength: number;
}

export interface PbrPreset extends Partial<PbrSettings> { channel: PbrChannel; description: string }

/** Built-in starting points; the user's own saved presets are read from Blockbench too. */
export const PBR_PRESETS: Record<string, PbrPreset> = {
  height_from_brightness: { channel: 'height', method: 'brightness', description: 'Bright = raised, dark = recessed. Stone, bark, bricks.' },
  normal_from_brightness: { channel: 'normal', method: 'brightness', description: 'Bumps from brightness. Mortar lines and cracks become grooves.' },
  normal_soft: { channel: 'normal', method: 'brightness', strength: 0.5, description: 'Gentler bumps for cloth, skin and painted wood.' },
  roughness_matte: { channel: 'roughness', method: 'brightness', invert: true, out_range: [150, 255], description: 'Mostly rough; darker cavities are the roughest. Stone, dirt, fabric.' },
  roughness_glossy: { channel: 'roughness', method: 'brightness', invert: true, out_range: [0, 110], description: 'Mostly smooth, slightly rougher in dark areas. Plastic, polished wood, ceramics.' },
  metal_from_grey: { channel: 'metalness', method: 'saturation', invert: true, in_range: [0, 60], description: 'Grey, unsaturated pixels become metal; coloured pixels stay non-metal. Armour trim, tools.' },
  emissive_brightest: { channel: 'emissive', method: 'brightness', in_range: [200, 255], description: 'Only the brightest pixels glow. Eyes, lamps, runes.' },
};

export function presetSettings(preset: Partial<PbrSettings> = {}): PbrSettings {
  return {
    method: preset.method ?? 'brightness',
    in_range: preset.in_range ?? [0, 255],
    out_range: preset.out_range ?? [0, 255],
    invert: !!preset.invert,
    strength: preset.strength ?? 1,
  };
}

/** One input value per pixel, 0-255 (hue and saturation scale with alpha like Blockbench's). */
function pixelInput(method: PbrMethod, r: number, g: number, b: number, a: number): number {
  switch (method) {
    case 'empty': return 0;
    case 'value': return ((r + g + b) / 3) * (a / 255);
    case 'brightness': return (r * 299 + g * 587 + b * 114) / 1000;
    case 'red': return r * (a / 255);
    case 'green': return g * (a / 255);
    case 'blue': return b * (a / 255);
    case 'saturation':
    case 'hue': {
      const R = r / 255, G = g / 255, B = b / 255;
      const max = Math.max(R, G, B), min = Math.min(R, G, B);
      if (max === min) return 0;
      const d = max - min;
      if (method === 'saturation') {
        const avg = (max + min) / 2;
        return (avg > 0.5 ? d / (2 - max - min) : d / (max + min)) * a;
      }
      let h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
      return (h / 6) * a;
    }
  }
}

/** The remapped value of every pixel, 0-255. */
export function pbrValues(src: { data: ArrayLike<number>; width: number; height: number }, s: PbrSettings): Float32Array {
  const out = new Float32Array(src.width * src.height);
  const [i0, i1] = s.in_range, [o0, o1] = s.out_range;
  for (let p = 0; p < out.length; p++) {
    const k = p * 4;
    const input = pixelInput(s.method, src.data[k], src.data[k + 1], src.data[k + 2], src.data[k + 3]);
    let t = i1 === i0 ? (input >= i1 ? 1 : 0) : (input - i0) / (i1 - i0);
    if (s.invert) t = 1 - t;
    out[p] = Math.max(0, Math.min(255, o0 + (o1 - o0) * t));
  }
  return out;
}

/** Write a height or normal map into `rgba` (fully opaque, like Blockbench's). */
export function encodeMap(channel: 'height' | 'normal', values: Float32Array, width: number, height: number, rgba: Uint8ClampedArray, strength = 1) {
  const at = (x: number, y: number) => values[y * width + x];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = at(x, y);
      if (channel === 'height') {
        rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      } else {
        const left = x > 0 ? at(x - 1, y) : v, right = x < width - 1 ? at(x + 1, y) : v;
        const top = y > 0 ? at(x, y - 1) : v, bottom = y < height - 1 ? at(x, y + 1) : v;
        rgba[i] = 127 - (right - left) * strength;
        rgba[i + 1] = 127 - (top - bottom) * strength;
        rgba[i + 2] = 255;
      }
      rgba[i + 3] = 255;
    }
  }
}

/** Replace one MER channel in `rgba`, leaving the other two as they are. */
export function encodeMerChannel(channel: PbrChannel, values: Float32Array, rgba: Uint8ClampedArray) {
  const offset = MER_INDEX[channel];
  if (offset === undefined) throw new Error(`${channel} is not a MER channel`);
  for (let p = 0; p < values.length; p++) {
    rgba[p * 4 + offset] = values[p];
    rgba[p * 4 + 3] = 255;
  }
}
