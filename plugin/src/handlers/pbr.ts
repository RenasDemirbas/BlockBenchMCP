// generate_pbr_map: derive height, normal and MER (metalness / emissive /
// roughness) maps from a colour texture and file them into its material
// (a texture group with is_material), without Blockbench's dialog.
import { register, fail, requireProject } from '../registry';
import { resolveTexture, describeTexture } from '../util';
import { paintTarget, commitBitmap } from './layers';
import {
  PBR_CHANNELS, PBR_METHODS, PBR_PRESETS, PbrChannel, PbrSettings, presetSettings, pbrValues,
  encodeMap, encodeMerChannel, textureChannelOf,
} from '../texturing/pbrmap';

/** Presets the user saved in Blockbench's own Generate PBR Map dialog (5.2+). */
function userPresets(): any[] {
  try {
    return (StateMemory.get?.('generate_pbr_map_presets') || StateMemory.generate_pbr_map_presets || []) as any[];
  } catch {
    return [];
  }
}

function listPresets() {
  return {
    built_in: Object.entries(PBR_PRESETS).map(([name, p]) => ({ name, ...p })),
    saved_in_blockbench: userPresets().map((p: any) => ({ name: p.name, channel: p.channel, method: p.method, in_range: p.in_range, out_range: p.out_range, invert: p.invert })),
  };
}

/** Turn one map request (preset name and/or explicit fields) into a channel + settings. */
function resolveMap(def: any, i: number): { channel: PbrChannel; settings: PbrSettings; preset?: string } {
  const label = `maps[${i}]`;
  let base: any = {};
  if (def.preset) {
    base = PBR_PRESETS[def.preset] ?? userPresets().find((p: any) => String(p.name).toLowerCase() === String(def.preset).toLowerCase());
    if (!base) fail(`${label}: unknown preset "${def.preset}". Built-in: ${Object.keys(PBR_PRESETS).join(', ')}. Pass "list_presets": true for the user's saved ones.`);
  }
  const channel: PbrChannel = def.channel ?? base.channel;
  if (!PBR_CHANNELS.includes(channel)) fail(`${label}: channel must be one of ${PBR_CHANNELS.join(', ')}.`);
  const merged = { ...base, ...Object.fromEntries(Object.entries(def).filter(([, v]) => v !== undefined)) };
  if (merged.method && !PBR_METHODS.includes(merged.method)) fail(`${label}: method must be one of ${PBR_METHODS.join(', ')}.`);
  for (const key of ['in_range', 'out_range']) {
    const r = merged[key];
    if (r !== undefined && (!Array.isArray(r) || r.length !== 2 || r.some((n: any) => typeof n !== 'number'))) fail(`${label}: ${key} must be [min, max] in 0-255.`);
  }
  return { channel, settings: presetSettings(merged), preset: def.preset };
}

/** The material group the colour texture belongs to, creating or promoting one if needed. */
function ensureMaterial(tex: any, newGroups: any[]): { group: any; note?: string } {
  const existing = tex.getGroup?.();
  if (existing?.is_material) return { group: existing };
  if (existing) {
    existing.is_material = true;
    return { group: existing, note: `Texture group "${existing.name}" was turned into a material.` };
  }
  const group = new TextureGroup({ is_material: true, name: `${tex.name.replace(/\.\w+$/, '')} material` });
  if (group.material_config) group.material_config.saved = false;
  group.add(false);
  tex.group = group.uuid;
  newGroups.push(group);
  return { group, note: `Created material "${group.name}" for "${tex.name}".` };
}

function blankCanvas(w: number, h: number, fill = '#000000') {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  return { canvas, ctx };
}

register('generate_pbr_map', async (params) => {
  if (params.list_presets) return listPresets();
  requireProject();
  if (!Format.pbr) fail(`Format "${Format.id}" has no PBR materials. Use "free", "bedrock" or "java_block".`);
  if (typeof TextureGroup === 'undefined') fail(`Materials need Blockbench 5.0 or newer (this is ${Blockbench.version}).`);
  const source = resolveTexture(params.texture);
  if ((source.pbr_channel ?? 'color') !== 'color') fail(`"${source.name}" is a ${source.pbr_channel} map. Pass the colour texture as "texture".`);
  const defs: any[] = Array.isArray(params.maps) && params.maps.length ? params.maps : [{}];
  const maps = defs.map(resolveMap);

  const w = source.width, h = source.height;
  const pixels = source.canvas.getContext('2d').getImageData(0, 0, w, h);
  const newGroups: any[] = [];
  const touched: any[] = [];
  const created: any[] = [];
  const report: any[] = [];

  // Every texture this call may write is known up front, so one undo entry holds it all.
  const before = source.getGroup?.();
  const groupTextures = before ? before.getTextures() : [];
  Undo.initEdit({ texture_groups: before ? [before] : [], textures: [source, ...groupTextures], bitmap: true });
  let material: { group: any; note?: string };
  try {
    material = ensureMaterial(source, newGroups);
    const inGroup = () => (Texture.all as any[]).filter((t) => t.group === material.group.uuid);
    const base = source.name.replace(/\.\w+$/, '');
    for (const { channel, settings, preset } of maps) {
      const values = pbrValues(pixels, settings);
      const texChannel = textureChannelOf(channel);
      let target = inGroup().find((t) => t.pbr_channel === texChannel && t !== source);
      if (target && (target.width !== w || target.height !== h)) {
        fail(`"${target.name}" (${texChannel}) is ${target.width}x${target.height} but "${source.name}" is ${w}x${h}. Resize one of them first (resize_texture).`);
      }
      if (!target) {
        // A new MER map starts neutral: no metal, no glow, fully rough (blue 255) —
        // a black blue channel would make every untouched pixel mirror-glossy.
        const { canvas } = blankCanvas(w, h, texChannel === 'mer' ? '#0000ff' : '#000000');
        target = new Texture({ name: `${base}_${texChannel}.png`, pbr_channel: texChannel, group: material.group.uuid }).fromDataURL(canvas.toDataURL());
        target.add(false);
        await new Promise<void>((resolve) => {
          const start = Date.now();
          const poll = () => (target.width > 0 || Date.now() - start > 2000 ? resolve() : setTimeout(poll, 20));
          poll();
        });
        created.push(target);
      }
      const dest = paintTarget(target);
      const img = dest.ctx.getImageData(0, 0, w, h);
      if (texChannel === 'mer') encodeMerChannel(channel, values, img.data);
      else encodeMap(channel as 'height' | 'normal', values, w, h, img.data, settings.strength);
      dest.ctx.putImageData(img, 0, 0);
      commitBitmap(target);
      touched.push(target);
      report.push({ channel, texture: target.name, created: created.includes(target), preset, settings });
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  Undo.finishEdit('MCP: Generate PBR map', {
    texture_groups: [...(before ? [before] : []), ...newGroups],
    textures: [source, ...groupTextures, ...created],
    bitmap: true,
  });
  setTimeout(() => material.group.updateMaterial?.(), 50);
  return {
    material: material.group.name,
    note: material.note,
    generated: report,
    textures: [...new Set(touched)].map(describeTexture),
    preview: 'capture_screenshot {view_mode: "material"} renders the model with these maps.',
  };
});
