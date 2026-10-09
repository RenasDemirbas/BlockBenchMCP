// Shared lookup + serialization helpers for command handlers.
import { fail } from './registry';

export type Vec3 = [number, number, number];

/** Resolve an outliner node (group or element) by uuid or name (case-insensitive). */
export function resolveNode(id: string): any {
  if (!id) fail('Missing element id. Pass a uuid or name from list_outline.');
  const byUuid = OutlinerNode.uuids[id];
  if (byUuid) return byUuid;
  const lower = String(id).toLowerCase();
  const nodes = Project.groups.concat(Project.elements);
  const matches = nodes.filter((n: any) => n.name.toLowerCase() === lower);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail(`Multiple nodes are named "${id}" (${matches.map((m: any) => m.uuid).join(', ')}). Use the uuid instead — see list_outline.`);
  }
  if (lower === 'root') {
    // "root" is the special PARENT keyword (top level of the outliner), not a
    // node — and rigs often also contain a real bone named "root". Say which.
    fail('"root" is the special parent keyword (top level of the outliner), not a selectable node, and this model has no group named "root" either. To target the whole model pass "*" (every cube); to target a bone pass its name — see list_outline.');
  }
  fail(`No element or group found with id or name "${id}". Use list_outline to see available nodes.`);
}

/**
 * Every cube under a target id, for the face-painting tools. Accepts "*" for
 * the whole model. Empty groups are the usual surprise here — a rig's top
 * "root" bone frequently holds only other bones — so the failure names the
 * subtree size and points at groups that DO hold cubes.
 */
export function collectCubes(id: string, context: string): any[] {
  if (id === '*' || id === '**') {
    if (!Cube.all.length) fail(`${context}: this model has no cubes at all.`);
    return [...Cube.all];
  }
  const node = resolveNode(id);
  const cubes: any[] = [];
  const collect = (n: any) => {
    if (n instanceof Cube) cubes.push(n);
    n.children?.forEach(collect);
  };
  collect(node);
  if (cubes.length) return cubes;

  if (node instanceof Group) {
    const withCubes = Project.groups
      .filter((g: any) => g !== node && g.children?.some((c: any) => c instanceof Cube))
      .map((g: any) => g.name);
    const descendants = (() => {
      let n = 0;
      const walk = (g: any) => g.children?.forEach((c: any) => { n++; walk(c); });
      walk(node);
      return n;
    })();
    fail(
      `${context}: group "${node.name}" holds no cubes (${node.children?.length ?? 0} direct children, ${descendants} descendants — an empty rig bone).`
      + ` Pass "*" to target every cube in the model (${Cube.all.length} total)`
      + (withCubes.length ? `, or one of the groups that do hold cubes: ${withCubes.slice(0, 12).join(', ')}${withCubes.length > 12 ? ', …' : ''}.` : '.')
    );
  }
  fail(`${context}: "${id}" is a ${node.type} and contains no cubes. These tools paint cube faces; for meshes use paint_texture with pixel coordinates.`);
}

export function resolveGroup(id: string): any {
  const node = resolveNode(id);
  if (node instanceof Group) return node;
  fail(`Node "${id}" is a ${node.type}, not a group/bone. Use list_outline to find groups.`);
}

export function resolveParent(id: string | undefined | null): any {
  if (!id || id === 'root') return 'root';
  return resolveGroup(id);
}

/** Resolve a texture by uuid, name, or id; undefined input → selected/default texture. */
export function resolveTexture(id?: string, optional = false): any {
  if (!id) {
    const tex = Texture.selected || Texture.getDefault();
    if (tex) return tex;
    if (optional) return undefined;
    fail('No texture specified and none selected. Use create_texture or list_textures first.');
  }
  const found = Texture.all.find((t: any) => t.uuid === id)
    || Texture.all.find((t: any) => t.name === id)
    || Texture.all.find((t: any) => t.name.replace(/\.png$/i, '') === String(id).replace(/\.png$/i, ''));
  if (!found) fail(`Texture "${id}" not found. Use list_textures to see available textures.`);
  return found;
}

export function resolveAnimation(id?: string): any {
  if (!id) {
    if (Animation.selected) return Animation.selected;
    if (Animation.all.length === 1) return Animation.all[0];
    fail('No animation specified and none selected. Pass the animation name or uuid — see list_animations.');
  }
  const found = Animation.all.find((a: any) => a.uuid === id) || Animation.all.find((a: any) => a.name === id);
  if (!found) fail(`Animation "${id}" not found. Use list_animations to see available animations.`);
  return found;
}

/**
 * Where files can be written. project_file save/export need absolute paths,
 * and there was previously no way to learn one from inside the MCP — callers
 * either guessed or reached for require('os'), which trips Blockbench's modal
 * permission prompt (see eval_code's guard). `SystemInfo` is a plain global and
 * costs nothing; `StateMemory.dialog_paths` is the folder the user last picked
 * per file type, which is usually the folder they actually want.
 */
export function systemPaths(detailed = false): any {
  const info: any = (typeof SystemInfo !== 'undefined' && SystemInfo) || {};
  const out: any = {
    home: info.home_directory,
    desktop: info.desktop_directory,
    temp: info.temp_directory,
    platform: info.platform,
    separator: typeof PathModule !== 'undefined' ? PathModule.sep : undefined,
    note: 'project_file save/export / eval_code(result_file) need ABSOLUTE paths — build one from these. "last_used" is the folder the user last saved that file type to.',
  };
  if (detailed) {
    out.appdata = info.appdata_directory;
    out.blockbench_user_data = info.user_data_directory;
    try {
      const dialogPaths = (typeof StateMemory !== 'undefined' && (StateMemory as any).dialog_paths) || null;
      if (dialogPaths) out.last_used = { ...dialogPaths };
    } catch { /* StateMemory is optional */ }
    try {
      const recent = (typeof recent_projects !== 'undefined' && recent_projects) || [];
      out.recent_projects = recent.slice(0, 5).map((p: any) => p.path).filter(Boolean);
    } catch { /* recent_projects is optional */ }
  }
  return out;
}

export function vec3(value: any, fallback?: Vec3): Vec3 | undefined {
  if (value == null) return fallback;
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => typeof n !== 'number' || !isFinite(n))) {
    fail(`Expected a [x, y, z] number array, got ${JSON.stringify(value)}`);
  }
  return value as Vec3;
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Compact JSON summary of an outliner node. */
export function describeNode(node: any, deep = false): any {
  const base: any = { uuid: node.uuid, name: node.name, type: node.type };
  if (node.parent && node.parent !== 'root') base.parent = node.parent.name;
  if (node instanceof Group) {
    base.origin = node.origin.slice();
    base.rotation = node.rotation.slice();
    base.children = node.children.length;
    if (node.visibility === false) base.visibility = false;
  } else if (node instanceof Cube) {
    base.from = node.from.slice();
    base.to = node.to.slice();
    base.origin = node.origin.slice();
    base.rotation = node.rotation.slice();
    if (node.inflate) base.inflate = node.inflate;
    if (node.shade_direction_override) base.shade_direction_override = node.shade_direction_override;
    base.box_uv = node.box_uv;
    if (node.box_uv) base.uv_offset = node.uv_offset.slice();
    if (node.visibility === false) base.visibility = false;
    if (deep) {
      base.faces = {};
      for (const fkey in node.faces) {
        const face = node.faces[fkey];
        const tex = face.texture === null ? null : face.texture === false ? false : (face.getTexture()?.name ?? face.texture);
        base.faces[fkey] = { uv: face.uv.slice(), rotation: face.rotation, texture: tex };
      }
    }
  } else if (node instanceof Mesh) {
    base.origin = node.origin.slice();
    base.rotation = node.rotation.slice();
    base.vertex_count = Object.keys(node.vertices).length;
    base.face_count = Object.keys(node.faces).length;
    if (deep) {
      base.vertices = {};
      for (const vkey in node.vertices) base.vertices[vkey] = node.vertices[vkey].slice();
      base.faces = {};
      for (const fkey in node.faces) {
        const face = node.faces[fkey];
        const uv: any = {};
        for (const vkey of face.vertices) uv[vkey] = (face.uv[vkey] || [0, 0]).slice();
        base.faces[fkey] = { vertices: face.vertices.slice(), uv, texture: face.getTexture()?.name ?? face.texture };
      }
    }
  } else if (typeof BoundingBox !== 'undefined' && node instanceof BoundingBox) {
    base.from = node.from.slice();
    base.to = node.to.slice();
    if (node.function?.length) base.function = node.function.slice();
  } else {
    if (node.position) base.position = node.position.slice?.() ?? node.position;
    if (node.rotation) base.rotation = node.rotation.slice?.() ?? node.rotation;
    if (node.type === 'null_object') {
      // IK controller wiring, by name so it reads without a uuid lookup.
      if (node.ik_target) base.ik_target = nodeLabel(node.ik_target);
      if (node.ik_source) base.ik_source = nodeLabel(node.ik_source);
      if (node.ik_pole) base.ik_pole = nodeLabel(node.ik_pole);
      if (node.lock_ik_target_rotation) base.lock_ik_target_rotation = true;
    }
  }
  return base;
}

/** Name of the node behind a uuid reference, or the raw uuid if it is gone. */
export function nodeLabel(uuid: string): string {
  const node = OutlinerNode.uuids[uuid];
  return node ? node.name : `${uuid} (missing)`;
}

/**
 * Which Blockbench 5.2 capabilities this app instance actually has. Tools that
 * depend on them check the same flags, so a 5.1 install gets a clear
 * "needs 5.2" error instead of a stack trace.
 */
export function featureSupport(): Record<string, boolean> {
  const has = (fn: () => any) => { try { return !!fn(); } catch { return false; } };
  return {
    texture_layer_groups: has(() => typeof TextureLayerGroup !== 'undefined'),
    ik_poles: has(() => NullObject.properties.ik_pole),
    movable_reference_models: has(() => typeof PreviewModel !== 'undefined' && StateMemory.preview_model_customization),
    reference_image_planes: has(() => ReferenceImage.properties.plane_position),
    shade_direction_override: has(() => Cube.properties.shade_direction_override),
    generic_bounding_boxes: has(() => Formats.free?.bounding_boxes),
    gltf_merge_armature: has(() => Codecs.gltf.export_options?.merge_armature),
  };
}

export function describeTexture(tex: any): any {
  return {
    uuid: tex.uuid,
    name: tex.name,
    width: tex.width,
    height: tex.height,
    uv_width: tex.getUVWidth(),
    uv_height: tex.getUVHeight(),
    internal: !!tex.internal,
    path: tex.path || undefined,
    particle: !!tex.particle,
    render_mode: tex.render_mode,
    pbr_channel: tex.pbr_channel !== 'color' ? tex.pbr_channel : undefined,
    group: tex.group || undefined,
    // Painting lands on ONE layer of a layered texture — worth knowing up front.
    layers: tex.layers_enabled
      ? { count: tex.layers.filter((l: any) => l.type !== 'layer_group').length, groups: tex.layers.filter((l: any) => l.type === 'layer_group').length, active: tex.getActiveLayer?.()?.name }
      : undefined,
  };
}

/** Ensure the viewport reflects programmatic edits to the given elements. */
export function refreshElements(elements: any[], aspects?: any) {
  const els = elements.filter((e: any) => e instanceof OutlinerElement);
  const groups = elements.filter((e: any) => e instanceof Group);
  if (els.length) {
    Canvas.updateView({
      elements: els,
      element_aspects: aspects || { transform: true, geometry: true, faces: true, uv: true },
    });
  }
  if (groups.length) {
    Canvas.updateAllBones(groups);
    for (const g of groups) {
      g.forEachChild((child: any) => child.preview_controller?.updateTransform?.(child));
    }
  }
}

export function parseColor(color: string | undefined, fallback = '#ffffff'): string {
  if (!color) return fallback;
  return color;
}

/**
 * How much of a texture is actually visible (alpha > 0). A fully transparent
 * texture is a silent killer: every face using it renders invisible, which
 * looks like "the screenshot tool returned a blank image".
 */
export function textureCoverage(texture: any): { visible_pixels: number; sampled_pixels: number; fully_transparent: boolean } {
  try {
    const canvas = texture.canvas;
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return { visible_pixels: 0, sampled_pixels: 0, fully_transparent: true };
    const stride = w * h > 1024 * 1024 ? 4 : 1; // subsample very large textures
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    let visible = 0, sampled = 0;
    for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        sampled++;
        if (data[(y * w + x) * 4 + 3] > 0) visible++;
      }
    }
    return { visible_pixels: visible * stride * stride, sampled_pixels: sampled, fully_transparent: visible === 0 };
  } catch {
    return { visible_pixels: -1, sampled_pixels: 0, fully_transparent: false };
  }
}

/** Deterministic 0..1 hash — reproducible jitter/noise (no Math.random). */
/** Cube face keys, in Blockbench's own order. */
export const FACE_KEYS = ['north', 'south', 'east', 'west', 'up', 'down'];

export function hash01(a: number, b: number, seed: number): number {
  let h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 1, 668265263) ^ Math.imul((seed | 0) + 1, 951274213);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
