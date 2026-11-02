// Bridge to the official "Hytale Models" Blockbench plugin (id hytale_plugin,
// by JannisX11 and Kanno). It registers the hytale_character / hytale_prop
// formats, the "blockymodel" codec and the .blockyanim animation files. This
// module is the only place that knows its API; Hytale's file formats are
// written by the plugin itself, never re-implemented here.

import { fail } from './registry';

export const HYTALE_FORMATS = ['hytale_character', 'hytale_prop'];

/** Hytale's renderer shows at most this many nodes per model. */
const MAX_NODE_COUNT = 255;

const INSTALL_HINT = 'Install the official "Hytale Models" plugin (File > Plugins > Available, search "Hytale"), then retry.';

export function isHytaleFormat(id: string | undefined = Format?.id): boolean {
  return !!id && HYTALE_FORMATS.includes(id);
}

/** Fail with install instructions when the Hytale plugin is not loaded. */
export function requireHytalePlugin(): void {
  if (!Codecs.blockymodel || !Formats.hytale_character) {
    fail(`The Hytale Models plugin is not loaded in Blockbench, so the Hytale formats and .blockymodel / .blockyanim files are unavailable. ${INSTALL_HINT}`);
  }
}

/** The plugin's blockymodel codec, for a project in a Hytale format. */
export function blockymodelCodec(): any {
  requireHytalePlugin();
  if (!isHytaleFormat()) {
    fail(`.blockymodel export needs a Hytale project, but the current format is "${Format.id}". Create one with create_project format "hytale_character" or "hytale_prop", or open a .blockymodel file.`);
  }
  return Codecs.blockymodel;
}

const qualifiesAsMainShape = (el: any) => el instanceof Cube && el.rotation.every((v: number) => v === 0);

/**
 * Nodes the exported model will have, counted like the plugin does: every
 * group is a node whose first unrotated cube becomes its shape; every other
 * cube is a node of its own. Collections (attachments) are left out.
 */
function nodeCount(): number {
  const inCollection = (el: any) => Collection.all.some((c: any) => c.contains(el));
  let count = 0;
  for (const group of Group.all) {
    if (group.export === false || inCollection(group)) continue;
    count++;
    const main = group.children.find(qualifiesAsMainShape);
    count += group.children.filter((c: any) => c instanceof Cube && c.export !== false && c !== main).length;
  }
  count += Outliner.root.filter((el: any) => el instanceof Cube && el.export !== false).length;
  return count;
}

/** Problems that make a .blockymodel export differ from what Blockbench shows. */
export function hytaleExportWarnings(): string[] {
  const warnings: string[] = [];
  const nodes = nodeCount();
  if (nodes > MAX_NODE_COUNT) {
    warnings.push(`The model has ${nodes} nodes; Hytale displays at most ${MAX_NODE_COUNT}. Merge small cubes or move parts into attachments.`);
  }
  for (const tex of Texture.all) {
    if (tex.uv_width !== tex.width || tex.uv_height !== tex.height) {
      warnings.push(`Texture "${tex.name}" is ${tex.width}x${tex.height} px but its UV size is ${tex.uv_width}x${tex.uv_height}; Hytale maps 1 texture pixel per unit. Fix with resize_texture at its current size and update_uv_size: true.`);
    }
  }
  const meshes = Project.elements.filter((el: any) => el instanceof Mesh).length;
  if (meshes) warnings.push(`${meshes} mesh element(s) are not part of the .blockymodel; Hytale models are cubes and quads only.`);
  const fractional = Cube.all.filter((c: any) => c.export !== false && c.size().some((v: number) => Math.abs(v - Math.round(v)) > 1e-4));
  if (fractional.length) {
    warnings.push(`${fractional.length} cube(s) have non-integer sizes (e.g. "${fractional[0].name}"), which misaligns their UVs. Use whole-unit sizes and the cube "stretch" for fine scaling.`);
  }
  return warnings;
}

/**
 * Write animations as .blockyanim files through the plugin, which overrides
 * Animation.save() for Hytale formats. "path" is a folder (one file per
 * animation, named after it) or, for a single animation, a .blockyanim file.
 */
export function writeBlockyanims(animations: any[], path: string): string[] {
  requireHytalePlugin();
  const singleFile = /\.blockyanim$/i.test(path);
  if (singleFile && animations.length > 1) {
    fail(`Hytale stores one animation per .blockyanim file, but ${animations.length} animations were selected. Pass a folder as "path" (each animation is written as <name>.blockyanim), or pick one animation.`);
  }
  const written: string[] = [];
  for (const anim of animations) {
    const file = singleFile ? path : PathModule.join(path, `${anim.name.replace(/[\\/:*?"<>|]/g, '_')}.blockyanim`);
    anim.path = file;
    anim.save();
    written.push(file);
  }
  return written;
}
