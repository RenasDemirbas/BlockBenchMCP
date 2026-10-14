// Textures: create, list, fetch, apply, template, resolution. Painting lives in ./paint.
import { register, fail, requireProject } from '../registry';
import { resolveNode, resolveTexture, describeTexture, clampInt, textureCoverage, FACE_KEYS } from '../util';
import { unthrottledTimersActive } from '../timers';
import { commitBitmap, findLayer } from './layers';
import { collectSurfaceElements, surfaceFaces, targetFaceKeys } from '../surface';

/**
 * generateTemplate runs behind a modal progress dialog and holds an open Undo
 * edit for its whole run. If we give up on it, cancelling that dialog is the
 * author's own abort path (onCancel rolls the edit back and the packing loops
 * bail out), and it stops a timed-out call from leaving the entire app wedged
 * behind a modal nobody is there to dismiss.
 */
function dismissTemplateProgress(): boolean {
  const dialog: any = Dialog.open;
  if (!dialog || dialog.id !== 'generate_template_progress') return false;
  try {
    dialog.cancel();
  } catch {
    try { dialog.close(1); } catch { return false; }
  }
  return true;
}

/** Only reachable if the timer patch could not be installed — see ../timers. */
function throttlingHint(): string {
  if (!document.hidden || unthrottledTimersActive()) return '';
  return " The Blockbench window is hidden and the unthrottled-timer patch is not active, so Chromium is throttling Blockbench's progress loop to roughly one step per second. Bring the window to the front and retry.";
}

/** Wait until a texture's bitmap has actually loaded (fromDataURL is async). */
async function awaitTextureLoad(texture: any, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (texture.width > 0 && texture.height > 0 && texture.img?.complete !== false) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return texture.width > 0;
}

/**
 * Wait until a texture's reported size stops changing. Needed after
 * TextureGenerator: its callback can fire before the generated bitmap is
 * swapped in, so the size may still be the 16x16 placeholder for a moment.
 */
async function awaitTextureSettle(texture: any, timeoutMs = 3000, stableMs = 400): Promise<void> {
  const start = Date.now();
  let lastW = texture.width, lastH = texture.height;
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 30));
    if (texture.width !== lastW || texture.height !== lastH) {
      lastW = texture.width;
      lastH = texture.height;
      stableSince = Date.now();
      continue;
    }
    if (texture.width > 0 && texture.img?.complete !== false && Date.now() - stableSince >= stableMs) return;
  }
}

// Java block/item models export it as {"sprite", "force_translucent": true} (Blockbench 5.2.2+).
function requireForceTranslucent(params: any) {
  if (params.force_translucent && !Texture.properties.force_translucent) fail(`force_translucent needs Blockbench 5.2.2 or newer (this is ${Blockbench.version}).`);
}

register('create_texture', async (params) => {
  requireProject();
  requireForceTranslucent(params);
  const width = clampInt(params.width ?? Project.texture_width ?? 16, 1, 4096);
  const height = clampInt(params.height ?? Project.texture_height ?? 16, 1, 4096);
  const name = params.name || 'texture';

  let dataUrl: string;
  if (params.data) {
    dataUrl = params.data.startsWith('data:') ? params.data : `data:image/png;base64,${params.data}`;
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    if (params.fill_color) {
      ctx.fillStyle = params.fill_color;
      ctx.fillRect(0, 0, width, height);
    }
    dataUrl = canvas.toDataURL('image/png');
  }

  Undo.initEdit({ textures: [], selected_texture: true });
  const texture = new Texture({
    name: /\.\w{3,4}$/.test(name) ? name : `${name}.png`,
    uv_width: width,
    uv_height: height,
  }).fromDataURL(dataUrl);
  if (params.pbr_channel) texture.pbr_channel = params.pbr_channel;
  if (params.render_mode) texture.render_mode = params.render_mode;
  if (params.force_translucent) texture.force_translucent = true;
  texture.add(false);
  if (params.particle) texture.enableParticle();
  texture.select();
  Undo.finishEdit('MCP: Create texture', { textures: [texture], selected_texture: true, bitmap: true });

  // The bitmap loads asynchronously — wait for it so the reported size is real
  // and the viewport shows the texture without a manual refresh.
  const loaded = await awaitTextureLoad(texture);
  Canvas.updateAllFaces(texture);
  Canvas.updateAllUVs();

  if (params.apply_to_all) {
    // Texture.apply() works on the current selection and no-ops when empty —
    // select everything first so "all" really means all.
    unselectAllElements();
    Project.elements.forEach((el: any) => el.markAsSelected?.());
    updateSelection();
    texture.apply(true);
  }
  const out: any = describeTexture(texture);
  const cov = textureCoverage(texture);
  out.visible_pixels = cov.visible_pixels;
  if (!loaded) {
    out.note = 'Texture bitmap did not finish loading within 3s — check the "data" payload.';
  } else if (cov.fully_transparent) {
    out.warning = 'This texture is FULLY TRANSPARENT (no visible pixels). Faces using it render invisible — the model will look like it disappeared and screenshots will come back blank. Paint it (paint_faces / paint_texture) or pass "fill_color" / non-empty "data".';
  }
  return out;
});

/** Template resolution (16 = 1 texture px per model unit). Out of range fails instead of being clamped silently. */
export function pixelDensityParam(value: any): number {
  const d = Number(value ?? 16);
  if (!Number.isFinite(d) || d < 1 || d > 512) fail(`pixel_density must be 1-512 (16 = 1 texture px per model unit, 256 = 16 px); got ${value}.`);
  return Math.round(d);
}

/**
 * Run Blockbench's template generator on the currently selected elements and
 * resolve with the new texture once it has settled.
 */
export async function runTextureTemplate(o: {
  name: string; pixelDensity: number; rearrange_uv: boolean; color?: string; power: boolean; padding: boolean;
  combine_polys: boolean; max_edge_angle: number; max_island_angle: number;
}): Promise<any> {
  const texture: any = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const dismissed = dismissTemplateProgress();
      reject(new Error(
        `Texture template generation timed out after 30s.${dismissed ? ' Its progress dialog was cancelled, so Blockbench is not left blocked behind a modal.' : ''}` +
        ` Try a lower pixel_density, or pass "elements" to template fewer elements at a time.${throttlingHint()}`
      ));
    }, 30000);
    try {
      TextureGenerator.addBitmap({
        name: o.name,
        folder: 'block',
        type: 'template',
        // String on purpose: 5.1.5's addBitmap guard coerces non-array numbers
        // to [16,16], but a numeric STRING survives it and generateTemplate
        // divides it by 16 to get the pixel density multiplier.
        resolution: String(o.pixelDensity),
        rearrange_uv: o.rearrange_uv,
        color: o.color ? (window as any).tinycolor(o.color) : undefined,
        power: o.power,
        padding: o.padding,
        particle: 'auto',
        compress: false,
        double_use: false,
        combine_polys: o.combine_polys,
        max_edge_angle: o.max_edge_angle,
        max_island_angle: o.max_island_angle,
      }, (tex: any) => {
        clearTimeout(timer);
        resolve(tex);
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
  await awaitTextureSettle(texture);
  return texture;
}

register('generate_texture_template', async (params) => {
  requireProject();
  if (!Texture.all.length || params.new_texture !== false) {
    // TextureGenerator template flow operates on selected elements (or all in single-texture formats)
    unselectAllElements();
    const targets = Array.isArray(params.elements) && params.elements.length
      ? params.elements.map((id: string) => resolveNode(id))
      : Project.elements;
    targets.forEach((el: any) => el.markAsSelected?.());
    updateSelection();
  }
  const pixelDensity = pixelDensityParam(params.pixel_density);
  const texture: any = await runTextureTemplate({
    name: params.name || `${Project.name || 'model'}_texture`,
    pixelDensity,
    rearrange_uv: params.rearrange_uv !== false,
    color: params.color,
    power: params.power_of_two !== false,
    padding: params.padding === true,
    combine_polys: false,
    max_edge_angle: 36,
    max_island_angle: 45,
  });
  Canvas.updateAllUVs();
  Canvas.updateAllFaces();
  return { generated: true, texture: describeTexture(texture), note: 'Element UVs were re-arranged onto the new template texture.' };
});

register('list_textures', () => {
  requireProject();
  return Texture.all.map(describeTexture);
});

register('delete_texture', (params) => {
  requireProject();
  const texture = resolveTexture(params.id);
  const name = texture.name;
  Undo.initEdit({ textures: [texture] });
  texture.remove(true);
  Undo.finishEdit('MCP: Delete texture', { textures: [] });
  Canvas.updateAllFaces();
  return { deleted: name, remaining: Texture.all.length };
});

/**
 * Bitmap-pixel rect of the faces named by an element/face selector, so a single
 * face can be zoomed instead of squinting at the whole atlas. Faces are matched
 * against ONE texture: painting is per-face, so a crop spanning two textures
 * would be meaningless.
 */
function faceCropRegion(params: any, explicitTexture: any) {
  const keys: string[] = params.face
    ? [params.face]
    : (!params.faces || params.faces === 'all' ? FACE_KEYS : params.faces);

  const els = collectSurfaceElements(params.element, 'get_texture');
  const cubes = els.filter((e: any) => e instanceof Cube);

  const byTexture = new Map<any, { label: string; uv: number[] }[]>();
  for (const mesh of els.filter((e: any) => e instanceof Mesh)) {
    const wanted = params.face ? [params.face] : (!params.faces || params.faces === 'all' ? 'all' : params.faces);
    const sfs = surfaceFaces([mesh], { faces: targetFaceKeys(mesh, wanted), texture: explicitTexture || undefined });
    for (const f of sfs) {
      // Express the polygon's bounding rect in UV units like a cube face.
      const fx = f.tex.width / f.tex.getUVWidth(), fy = f.tex.height / f.tex.getUVHeight();
      const xs = f.px.map((p) => p[0] / fx), ys = f.px.map((p) => p[1] / fy);
      if (!byTexture.has(f.tex)) byTexture.set(f.tex, []);
      byTexture.get(f.tex)!.push({ label: `${mesh.name}.${f.key}`, uv: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    }
  }
  for (const cube of cubes) {
    for (const k of keys) {
      const face = cube.faces[k];
      if (!face || face.texture === null || face.enabled === false) continue;
      const tex = face.getTexture?.() || explicitTexture;
      if (!tex) continue;
      if (!byTexture.has(tex)) byTexture.set(tex, []);
      byTexture.get(tex)!.push({ label: `${cube.name}.${k}`, uv: face.uv.slice() });
    }
  }
  if (!byTexture.size) {
    fail(`No textured faces matched element "${params.element}" / faces ${JSON.stringify(keys)}. Check the face keys, or assign a texture with apply_texture.`);
  }
  let texture = explicitTexture;
  if (texture && !byTexture.has(texture)) {
    fail(`None of the matched faces use texture "${texture.name}". They use: ${[...byTexture.keys()].map((t: any) => t.name).join(', ')}.`);
  }
  if (!texture) {
    if (byTexture.size > 1) {
      // Pick the texture carrying the most matched faces, but say so.
      fail(`Those faces span ${byTexture.size} textures (${[...byTexture.entries()].map(([t, l]: any) => `${t.name}: ${l.length} faces`).join(', ')}). Pass "id" to choose one.`);
    }
    texture = [...byTexture.keys()][0];
  }
  const faces = byTexture.get(texture)!;

  const fx = texture.width / texture.getUVWidth();
  const fy = texture.height / texture.getUVHeight();
  const pad = (params.padding ?? 0);
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const rects = faces.map((f) => {
    const rx1 = Math.min(f.uv[0], f.uv[2]) * fx, rx2 = Math.max(f.uv[0], f.uv[2]) * fx;
    const ry1 = Math.min(f.uv[1], f.uv[3]) * fy, ry2 = Math.max(f.uv[1], f.uv[3]) * fy;
    x1 = Math.min(x1, rx1); y1 = Math.min(y1, ry1);
    x2 = Math.max(x2, rx2); y2 = Math.max(y2, ry2);
    return { face: f.label, uv: f.uv, pixel_rect: [Math.floor(rx1), Math.floor(ry1), Math.ceil(rx2), Math.ceil(ry2)] };
  });
  const px = Math.max(0, Math.floor(x1 - pad * fx));
  const py = Math.max(0, Math.floor(y1 - pad * fy));
  const pw = Math.min(texture.width, Math.ceil(x2 + pad * fx)) - px;
  const ph = Math.min(texture.height, Math.ceil(y2 + pad * fy)) - py;
  if (pw < 1 || ph < 1) fail(`The matched faces have a zero-size UV rect (${pw}x${ph} px) — nothing to crop. Run generate_texture_template or uv action "inspect".`);
  return { texture, region: { x: px, y: py, width: pw, height: ph }, faces: rects };
}

/** One layer on its own, placed at its offset on a texture-sized canvas. */
function isolatedLayerCanvas(texture: any, layerId: string): { canvas: any; layer: any } {
  const layer = findLayer(texture, layerId);
  if (!layer) {
    fail(`Texture "${texture.name}" has no layer "${layerId}". ${texture.layers_enabled ? `Layers: ${texture.layers.map((l: any) => l.name).join(', ')}.` : 'Layers are not enabled on it — see texture_layers.'}`);
  }
  if (layer.type === 'layer_group') fail(`"${layer.name}" is a layer group; pick one of its pixel layers.`);
  const canvas = document.createElement('canvas');
  canvas.width = texture.width;
  canvas.height = texture.height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(layer.canvas, layer.offset[0], layer.offset[1], layer.scaled_width ?? layer.width, layer.scaled_height ?? layer.height);
  return { canvas, layer };
}

register('get_texture', (params) => {
  requireProject();
  const explicit = params.id ? resolveTexture(params.id) : null;
  const crop = params.element ? faceCropRegion(params, explicit) : null;
  const texture = crop ? crop.texture : resolveTexture(params.id);
  const maxSize = clampInt(params.max_size ?? 512, 16, 2048);
  const isolated = params.layer ? isolatedLayerCanvas(texture, params.layer) : null;
  const source = isolated ? isolated.canvas : texture.canvas;

  const srcX = crop ? crop.region.x : 0;
  const srcY = crop ? crop.region.y : 0;
  const srcW = crop ? crop.region.width : texture.width;
  const srcH = crop ? crop.region.height : texture.height;

  let dataUrl: string;
  if (!crop && texture.width <= maxSize && texture.height <= maxSize && params.scale == null) {
    dataUrl = source.toDataURL('image/png');
  } else {
    // A crop is meant to be INSPECTED, so a small face is scaled UP to fill
    // max_size rather than returned as a handful of pixels.
    const scale = Math.min(maxSize / srcW, maxSize / srcH, params.scale ?? Infinity);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(srcW * scale));
    canvas.height = Math.max(1, Math.round(srcH * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = scale > 1 ? false : true;
    ctx.drawImage(source, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
    dataUrl = canvas.toDataURL('image/png');
  }
  const cov = textureCoverage(texture);
  return {
    ...describeTexture(texture),
    showing_layer: isolated ? isolated.layer.name : undefined,
    visible_pixels: cov.visible_pixels,
    cropped_to: crop ? { ...crop.region, faces: crop.faces, zoom: Math.round((Math.min(maxSize / srcW, maxSize / srcH)) * 100) / 100 } : undefined,
    // A transparent PNG looks WHITE in most viewers — say so explicitly.
    warning: cov.fully_transparent
      ? 'This texture is FULLY TRANSPARENT — the image below is empty (transparent PNGs display as white/blank). Every face using it renders invisible.'
      : undefined,
    __image: dataUrl,
  };
});

register('import_texture', async (params) => {
  requireProject();
  if (!params.path) fail('Missing absolute "path" to an image file (png/jpeg/webp/tga).');
  requireForceTranslucent(params);
  Undo.initEdit({ textures: [], selected_texture: true });
  const texture = new Texture({ name: PathModule.basename(params.path) }).fromPath(params.path);
  if (params.force_translucent) texture.force_translucent = true;
  texture.add(false, true);
  Undo.finishEdit('MCP: Import texture', { textures: [texture], selected_texture: true, bitmap: true });
  await awaitTextureLoad(texture);
  Canvas.updateAllFaces(texture);
  return describeTexture(texture);
});

register('apply_texture', (params) => {
  requireProject();
  const texture = resolveTexture(params.texture);
  texture.select();
  if (Array.isArray(params.elements) && params.elements.length) {
    const nodes = params.elements.map((id: string) => resolveNode(id));
    const elements: any[] = [];
    const collect = (n: any) => {
      if (n.faces) elements.push(n);
      n.children?.forEach(collect);
    };
    nodes.forEach(collect);
    Undo.initEdit({ elements });
    for (const el of elements) {
      el.applyTexture(texture, params.faces ?? true);
    }
    Canvas.updateView({ elements, element_aspects: { faces: true, uv: true } });
    Undo.finishEdit('MCP: Apply texture', { elements });
    return { applied_to: elements.map((e) => e.name), texture: texture.name };
  }
  // Fall back to Blockbench semantics: all faces / blank faces of ALL elements
  unselectAllElements();
  Project.elements.forEach((el: any) => el.markAsSelected?.());
  updateSelection();
  texture.apply(params.mode === 'blank' ? 'blank' : true);
  return { applied_to: 'all elements', mode: params.mode || 'all', texture: texture.name };
});

register('resize_texture', (params) => {
  requireProject();
  const texture = resolveTexture(params.texture);
  const width = clampInt(params.width, 1, 4096);
  const height = clampInt(params.height, 1, 4096);
  Undo.initEdit({ textures: [texture], bitmap: true });
  const stretch = params.stretch !== false;
  if (texture.layers_enabled) {
    // texture.edit() would only resize the ACTIVE layer; scale every pixel
    // layer (and its offset) so the composite keeps its arrangement.
    const sx = width / texture.width, sy = height / texture.height;
    for (const layer of texture.layers) {
      if (layer.type === 'layer_group' || !stretch) continue;
      const copy = document.createElement('canvas');
      copy.width = layer.width;
      copy.height = layer.height;
      copy.getContext('2d')!.drawImage(layer.canvas, 0, 0);
      layer.canvas.width = Math.max(1, Math.round(copy.width * sx));
      layer.canvas.height = Math.max(1, Math.round(copy.height * sy));
      layer.ctx.imageSmoothingEnabled = false;
      layer.ctx.drawImage(copy, 0, 0, layer.canvas.width, layer.canvas.height);
      layer.offset.replace([Math.round(layer.offset[0] * sx), Math.round(layer.offset[1] * sy)]);
    }
    texture.width = width;
    texture.height = height;
    commitBitmap(texture);
  } else {
    const old = document.createElement('canvas');
    old.width = texture.canvas.width;
    old.height = texture.canvas.height;
    old.getContext('2d')!.drawImage(texture.canvas, 0, 0);
    texture.edit((canvas: HTMLCanvasElement, env: any) => {
      canvas.width = width;
      canvas.height = height;
      const ctx = env.ctx as CanvasRenderingContext2D;
      ctx.imageSmoothingEnabled = false;
      if (stretch) {
        ctx.drawImage(old, 0, 0, width, height);
      } else {
        ctx.drawImage(old, 0, 0);
      }
    }, { no_undo: true });
    texture.width = width;
    texture.height = height;
  }
  if (Format.per_texture_uv_size && params.update_uv_size) {
    texture.uv_width = width;
    texture.uv_height = height;
  }
  Undo.finishEdit('MCP: Resize texture');
  Canvas.updateAllUVs();
  return describeTexture(texture);
});

register('set_texture_resolution', (params) => {
  requireProject();
  if (!params.width || !params.height) fail('Pass "width" and "height" (the UV grid size, e.g. 64x64).');
  UVSizeUtil.adjustProjectResolution(clampInt(params.width, 1, 4096), clampInt(params.height, 1, 4096), params.modify_uv === true);
  return { texture_size: [Project.texture_width, Project.texture_height] };
});
