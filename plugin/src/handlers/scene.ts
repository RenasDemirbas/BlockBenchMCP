// Viewport companions that are not part of the model: reference models
// (player, crafting table, ... — movable since Blockbench 5.2) and reference
// images, including 5.2's 3D "plane" images placed in the scene.
import { register, fail, requireProject } from '../registry';
import { vec3 } from '../util';

// ───────────────────────────── reference models ─────────────────────────────

function requirePreviewModels() {
  if (typeof PreviewModel === 'undefined') fail(`Reference models are not available in this Blockbench (${Blockbench.version}).`);
}

function findPreviewModel(id: string): any {
  const models = PreviewModel.models;
  if (models[id]) return models[id];
  const lower = String(id).toLowerCase();
  const found = Object.values(models).find((m: any) => String(m.name).toLowerCase() === lower || m.id.toLowerCase() === lower);
  if (!found) {
    const ids = Object.values(models).filter((m: any) => !m.internal).map((m: any) => m.id);
    fail(`No reference model "${id}". Available: ${ids.join(', ')}.`);
  }
  return found;
}

function describePreviewModel(model: any): any {
  const custom = (typeof StateMemory !== 'undefined' && StateMemory.preview_model_customization?.[model.id]) || null;
  const o = model.model_3d;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    id: model.id,
    name: model.name || model.id,
    enabled: !!model.enabled,
    shown: !!model.enabled && o.visible !== false,
    position: o.position.toArray().map(round),
    rotation: [o.rotation.x, o.rotation.y, o.rotation.z].map((r: number) => round(r * 180 / Math.PI)),
    scale: o.scale.toArray().map(round),
    customized: !!custom,
  };
}

register('preview_models', (params) => {
  requireProject();
  requirePreviewModels();
  const defs: any[] = Array.isArray(params.models) ? params.models : [];
  const movable = !!StateMemory?.preview_model_customization;
  const changed: string[] = [];
  for (const def of defs) {
    const model = findPreviewModel(def.id);
    if (def.enabled === true && !model.enabled) { model.enable(); changed.push(`enabled ${model.id}`); }
    if (def.enabled === false && model.enabled) { model.disable(); changed.push(`disabled ${model.id}`); }
    const transform = def.position || def.rotation || def.scale;
    if (def.reset || transform) {
      if (!movable) fail(`Moving reference models needs Blockbench 5.2 or newer (this is ${Blockbench.version}).`);
      const store = StateMemory.preview_model_customization;
      if (def.reset) delete store[model.id];
      if (transform) {
        // Same storage the viewport gizmo writes to, so the placement survives
        // restarts and the user can keep adjusting it by hand.
        const entry = store[model.id] || (store[model.id] = {});
        if (def.position) entry.position = vec3(def.position)!.slice();
        if (def.rotation) entry.rotation = vec3(def.rotation)!.slice();
        if (def.scale != null) entry.scale = typeof def.scale === 'number' ? [def.scale, def.scale, def.scale] : vec3(def.scale)!.slice();
      }
      StateMemory.save('preview_model_customization');
      changed.push(`${def.reset ? 'reset' : 'moved'} ${model.id}`);
    }
    model.update();
  }
  const list = Object.values(PreviewModel.models)
    .filter((m: any) => !m.internal || m.enabled)
    .map(describePreviewModel);
  return {
    models: list,
    changed: changed.length ? changed : undefined,
    note: 'Enabled reference models render in capture_screenshot (pass include_reference_models: true to frame them). Positions are model units; their placement is remembered across restarts.',
  };
});

// ───────────────────────────── reference images ─────────────────────────────

/** 3D plane images are CSS objects scaled by block_size/128: 8 px per unit. */
const pxPerUnit = () => 128 / (Format?.block_size || 16);

function allReferenceImages(): any[] {
  return ReferenceImage.all.filter((r: any) => r.scope !== 'built_in');
}

function findReferenceImage(id: string): any {
  const lower = String(id).toLowerCase();
  const all = allReferenceImages();
  const found = all.find((r: any) => r.uuid === id) || all.find((r: any) => String(r.name).toLowerCase() === lower);
  if (!found) fail(`No reference image "${id}". Existing: ${all.map((r: any) => r.name).join(', ') || 'none'}.`);
  return found;
}

function describeReferenceImage(ref: any): any {
  const out: any = {
    uuid: ref.uuid,
    name: ref.name,
    view_mode: ref.view_mode,
    layer: ref.layer,
    scope: ref.scope,
    visible: ref.visibility !== false,
    opacity: ref.opacity,
    loaded: !!ref.image_is_loaded,
    source: typeof ref.source === 'string' && ref.source.startsWith('data:') ? '[embedded image]' : ref.source,
  };
  if (ref.view_mode === 'plane') {
    out.plane_position = ref.plane_position?.slice();
    out.plane_rotation = ref.plane_rotation?.slice();
    out.plane_size = ref.size.map((v: number) => Math.round((v / pxPerUnit()) * 100) / 100);
  } else {
    out.position = ref.position.slice();
    out.size = ref.size.slice();
    if (ref.view_mode === 'blueprint') out.attached_side = ref.attached_side;
  }
  return out;
}

/** Shared add/update property mapping. */
function applyReferenceImageProps(ref: any, def: any) {
  const data: any = {};
  for (const key of ['name', 'opacity', 'cull_backface', 'clear_mode', 'flip_x', 'flip_y', 'rotation', 'attached_side', 'sync_to_timeline']) {
    if (def[key] !== undefined) data[key] = def[key];
  }
  if (def.visible !== undefined) data.visibility = def.visible;
  if (def.position) data.position = def.position.slice();
  if (def.size) data.size = def.size.slice();
  if (def.plane_position) data.plane_position = vec3(def.plane_position)!.slice();
  if (def.plane_rotation) data.plane_rotation = vec3(def.plane_rotation)!.slice();
  if (def.plane_size != null) {
    const s = def.plane_size;
    if (Array.isArray(s)) data.size = [s[0] * pxPerUnit(), s[1] * pxPerUnit()];
    else {
      // Width only: keep the image's own aspect ratio (Blockbench corrects the
      // height once the image has loaded).
      ref.auto_aspect_ratio = true;
      const px = s * pxPerUnit();
      ref.size.replace([px, ref.aspect_ratio && ref.image_is_loaded ? px / ref.aspect_ratio : px]);
    }
  }
  ref.extend(data);
  if (def.view_mode) ref.view_mode = def.view_mode;
  if (def.layer && def.layer !== ref.layer) ref.changeLayer(def.layer);
  if (def.scope && def.scope !== ref.scope) ref.changeScope(def.scope);
}

async function waitForLoad(ref: any, ms = 2500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (ref.image_is_loaded) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !!ref.image_is_loaded;
}

register('reference_images', async (params) => {
  requireProject();
  if (typeof ReferenceImage === 'undefined') fail(`Reference images are not available in this Blockbench (${Blockbench.version}).`);
  const planesSupported = !!ReferenceImage.properties?.plane_position;
  const wantsPlane = (d: any) => d.view_mode === 'plane' || d.plane_position || d.plane_rotation || d.plane_size != null;
  const log: string[] = [];
  const warnings: string[] = [];

  for (const def of params.add || []) {
    if (!def.path) fail('Each reference image to add needs an absolute "path" to an image (png/jpg/gif/bmp/tiff) or video (mp4/mov/wmv).');
    const ext = String(def.path).split('.').pop()!.toLowerCase();
    if (!ReferenceImage.supported_extensions.includes(ext)) fail(`Unsupported reference file ".${ext}". Supported: ${ReferenceImage.supported_extensions.join(', ')}.`);
    if (wantsPlane(def) && !planesSupported) fail(`3D plane reference images need Blockbench 5.2 or newer (this is ${Blockbench.version}).`);
    const view_mode = def.view_mode || (wantsPlane(def) ? 'plane' : 'flat_image');
    const ref = new ReferenceImage({
      source: def.path,
      name: def.name || PathModule.basename(def.path),
      view_mode,
      layer: def.layer || 'background',
    });
    if (def.scope === 'global') ref.addAsGlobalReference(false);
    else ref.addAsReference(false);
    // addAs*Reference() flips to blueprint mode whenever the viewport sits on an
    // ortho preset — honour what was asked for instead.
    ref.view_mode = view_mode;
    applyReferenceImageProps(ref, { ...def, scope: undefined, layer: undefined });
    ref.update();
    const loaded = await waitForLoad(ref);
    if (!loaded) warnings.push(`"${ref.name}" did not load — check the path: ${def.path}`);
    if (def.plane_size != null && !Array.isArray(def.plane_size)) ref.update();
    ref.save();
    log.push(`added "${ref.name}" (${ref.view_mode})`);
  }

  for (const def of params.update || []) {
    const ref = findReferenceImage(def.id);
    if (wantsPlane(def) && !planesSupported) fail(`3D plane reference images need Blockbench 5.2 or newer (this is ${Blockbench.version}).`);
    applyReferenceImageProps(ref, def);
    ref.update().save();
    log.push(`updated "${ref.name}"`);
  }

  for (const id of params.remove || []) {
    const ref = findReferenceImage(id);
    await ref.delete(true); // force: skip the confirmation box
    log.push(`removed "${ref.name}"`);
  }

  if (log.length) {
    try { ReferenceImage.updateAll(); } catch {}
  }
  return {
    reference_images: allReferenceImages().map(describeReferenceImage),
    applied: log.length ? log : undefined,
    warnings: warnings.length ? warnings : undefined,
    note: 'Reference images are drawn by the viewport for the USER — they do not appear in capture_screenshot renders. "plane" images live in the 3D scene: plane_position/plane_size are model units, plane_rotation degrees.',
  };
});
