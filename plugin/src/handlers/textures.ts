// Textures: create, list, fetch, apply, paint (declarative primitives),
// face painting, fur ops (jagged_edge/noise), resolution.
import { register, fail, requireProject } from '../registry';
import { resolveNode, collectCubes, resolveTexture, describeTexture, clampInt, hash01, textureCoverage, FACE_KEYS } from '../util';
import { unthrottledTimersActive } from '../timers';

type PreparedOp = {
  op: any;
  map: (pt: number[]) => [number, number];
  /** Face geometry for targeted ops: pixel rect, world Y span, v-flip. */
  geo: { rect: number[]; worldY: [number, number]; vFlipped: boolean; rotated: boolean } | null;
};

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

register('create_texture', async (params) => {
  requireProject();
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
  const pixelDensity = clampInt(params.pixel_density ?? 16, 1, 128);
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
        name: params.name || `${Project.name || 'model'}_texture`,
        folder: 'block',
        type: 'template',
        // String on purpose: 5.1.5's addBitmap guard coerces non-array numbers
        // to [16,16], but a numeric STRING survives it and generateTemplate
        // divides it by 16 to get the pixel density multiplier.
        resolution: String(pixelDensity),
        rearrange_uv: params.rearrange_uv !== false,
        color: params.color ? (window as any).tinycolor(params.color) : undefined,
        power: params.power_of_two !== false,
        padding: params.padding === true,
        particle: 'auto',
        compress: false,
        double_use: false,
        combine_polys: false,
        max_edge_angle: 36,
        max_island_angle: 45,
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
  for (const k of keys) {
    if (!FACE_KEYS.includes(k)) fail(`Unknown face key "${k}". Valid: ${FACE_KEYS.join(', ')}.`);
  }
  const cubes = collectCubes(params.element, 'get_texture');

  const byTexture = new Map<any, { label: string; uv: number[] }[]>();
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
  if (pw < 1 || ph < 1) fail(`The matched faces have a zero-size UV rect (${pw}x${ph} px) — nothing to crop. Run generate_texture_template or inspect_uv.`);
  return { texture, region: { x: px, y: py, width: pw, height: ph }, faces: rects };
}

register('get_texture', (params) => {
  requireProject();
  const explicit = params.id ? resolveTexture(params.id) : null;
  const crop = params.element ? faceCropRegion(params, explicit) : null;
  const texture = crop ? crop.texture : resolveTexture(params.id);
  const maxSize = clampInt(params.max_size ?? 512, 16, 2048);

  const srcX = crop ? crop.region.x : 0;
  const srcY = crop ? crop.region.y : 0;
  const srcW = crop ? crop.region.width : texture.width;
  const srcH = crop ? crop.region.height : texture.height;

  let dataUrl: string;
  if (!crop && texture.width <= maxSize && texture.height <= maxSize && params.scale == null) {
    dataUrl = texture.canvas.toDataURL('image/png');
  } else {
    // A crop is meant to be INSPECTED, so a small face is scaled UP to fill
    // max_size rather than returned as a handful of pixels.
    const scale = Math.min(maxSize / srcW, maxSize / srcH, params.scale ?? Infinity);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(srcW * scale));
    canvas.height = Math.max(1, Math.round(srcH * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = scale > 1 ? false : true;
    ctx.drawImage(texture.canvas, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
    dataUrl = canvas.toDataURL('image/png');
  }
  const cov = textureCoverage(texture);
  return {
    ...describeTexture(texture),
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
  Undo.initEdit({ textures: [], selected_texture: true });
  const texture = new Texture({ name: PathModule.basename(params.path) }).fromPath(params.path);
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

/**
 * Declarative texture painting. Each op draws in pixel space; ops may instead
 * target a cube face ("target": {element, face}) with normalized 0-1 coords.
 * Targeted ops paint onto the FACE'S OWN texture; every op is validated
 * before any pixel is touched, so a bad op cannot bake a half-finished batch.
 */
register('paint_texture', (params) => {
  requireProject();
  if (!Array.isArray(params.ops) || !params.ops.length) {
    fail('Pass an "ops" array. Op types: pixel {pixels:[[x,y],...]}, line {from:[x,y], to:[x,y], thickness?}, rect {from, to, filled?}, ellipse {center:[x,y], radius:[rx,ry], filled?}, fill {at:[x,y], tolerance?}, gradient {stops:[{at,color,opacity}] or color/color2, space?:"world"}, clear {from, to}, jagged_edge, noise, strands. Each op takes color (hex/rgba string) and opacity (0-1). Target faces with "target": {element, face} or {element, faces:"all"} (element may be a group).');
  }
  const explicitTexture = params.texture ? resolveTexture(params.texture) : null;

  // Model-space Y extent — gradients with space: "world" position their stops
  // against this instead of each face's own 0-1 box, so shading runs unbroken
  // across neighbouring cubes rather than restarting on every one.
  const modelY = (() => {
    let lo = Infinity, hi = -Infinity;
    for (const el of Project.elements as any[]) {
      if (!el.from || !el.to) continue;
      lo = Math.min(lo, el.from[1], el.to[1]);
      hi = Math.max(hi, el.from[1], el.to[1]);
    }
    return Number.isFinite(lo) && hi > lo ? [lo, hi] : [0, 1];
  })();

  // ── Expand bulk targets: one op aimed at a group (or at several face keys)
  //    becomes one op per resolved face, so everything downstream stays
  //    single-face. {element, face} keeps working unchanged. ──
  const expandedOps: any[] = [];
  (params.ops as any[]).forEach((op: any, i: number) => {
    const t = op && op.target;
    if (!t || (t.face && !t.faces)) { expandedOps.push(op); return; }
    if (!t.faces) fail(`ops[${i}]: "target" needs "face" (one key) or "faces" ("all" or a list of keys).`);
    const keys: string[] = t.faces === 'all' ? FACE_KEYS.slice() : t.faces;
    if (!Array.isArray(keys) || !keys.length) fail(`ops[${i}]: "target.faces" must be "all" or a non-empty array of face keys.`);
    for (const k of keys) {
      if (!FACE_KEYS.includes(k)) fail(`ops[${i}]: unknown face key "${k}". Valid: ${FACE_KEYS.join(', ')}.`);
    }
    const cubes = collectCubes(t.element, `ops[${i}]`);
    for (const cube of cubes) {
      for (const k of keys) {
        const face = cube.faces[k];
        if (!face) continue;
        if (face.texture === null || face.enabled === false) continue; // hidden face
        expandedOps.push({ ...op, target: { element: cube.uuid, face: k } });
      }
    }
  });
  if (!expandedOps.length) fail('No paintable faces matched the given ops.');

  // ── Validate and resolve EVERY op before opening any texture edit ──
  const OP_TYPES = ['pixel', 'line', 'rect', 'ellipse', 'fill', 'gradient', 'clear', 'jagged_edge', 'noise', 'strands'];
  const prepared = expandedOps.map((op: any, i: number) => {
    const label = `ops[${i}] (${op.type})`;
    if (!OP_TYPES.includes(op.type)) {
      fail(`Unknown paint op type "${op.type}" at ops[${i}]. Valid: ${OP_TYPES.join(', ')}.`);
    }
    if (['line', 'rect', 'clear'].includes(op.type) && (!op.from || !op.to)) fail(`${label} needs "from" and "to".`);
    if (op.type === 'ellipse' && !op.center) fail(`${label} needs "center".`);
    if (op.type === 'fill' && !op.at) fail(`${label} needs "at".`);
    if (op.type === 'pixel' && !Array.isArray(op.pixels)) fail(`${label} needs "pixels": [[x,y],...].`);
    // A targeted gradient/strand defaults to a top-to-bottom sweep of the face.
    if (['gradient', 'strands', 'jagged_edge'].includes(op.type) && !op.target && (!op.from || !op.to)) {
      fail(`${label} needs "from"/"to" (pixel coords) or a "target" ({element, face} or {element, faces}).`);
    }
    if (op.type === 'gradient' && op.stops !== undefined) {
      if (!Array.isArray(op.stops) || !op.stops.length) fail(`${label}: "stops" must be a non-empty array of {at, color, opacity?}.`);
      for (const s of op.stops) {
        if (typeof s?.at !== 'number') fail(`${label}: every entry in "stops" needs a numeric "at" (0-1).`);
        if (!s.color) fail(`${label}: every entry in "stops" needs a "color".`);
      }
    }
    if (op.space !== undefined && !['face', 'world'].includes(op.space)) {
      fail(`${label}: "space" must be "face" (default) or "world".`);
    }
    if (op.space === 'world' && op.type !== 'gradient') {
      fail(`${label}: space "world" is only supported by the gradient op — it maps stops onto the model's Y extent.`);
    }
    if (op.space === 'world' && !op.target) {
      fail(`${label}: space "world" needs a face "target" — it derives the sweep from that face's world position.`);
    }
    if (op.type === 'jagged_edge' && op.edge && !['top', 'bottom', 'left', 'right'].includes(op.edge)) {
      fail(`${label}: "edge" must be top, bottom, left or right.`);
    }

    let tex = explicitTexture;
    let map: (pt: number[]) => [number, number];
    let geo: any = null;
    if (op.target) {
      const node = resolveNode(op.target.element);
      if (!(node instanceof Cube)) fail('paint ops "target" currently supports cube faces. For meshes paint with absolute pixel coordinates.');
      const face = node.faces[op.target.face];
      if (!face) fail(`Cube "${node.name}" has no face "${op.target.face}". Valid: north, south, east, west, up, down.`);
      const faceTex = face.getTexture?.() || null;
      if (faceTex && explicitTexture && faceTex !== explicitTexture) {
        fail(`Face "${node.name}.${op.target.face}" is mapped to texture "${faceTex.name}", not "${explicitTexture.name}" — omit "texture" or pass the face's own texture.`);
      }
      tex = faceTex || explicitTexture;
      if (!tex) fail(`Face "${node.name}.${op.target.face}" has no texture assigned. Assign one (apply_texture) or pass "texture".`);
      const fx = tex.width / tex.getUVWidth();
      const fy = tex.height / tex.getUVHeight();
      const x1 = Math.min(face.uv[0], face.uv[2]) * fx;
      const y1 = Math.min(face.uv[1], face.uv[3]) * fy;
      const w = Math.abs(face.uv[2] - face.uv[0]) * fx;
      const h = Math.abs(face.uv[3] - face.uv[1]) * fy;
      map = (pt) => [Math.round(x1 + pt[0] * w), Math.round(y1 + pt[1] * h)];
      // Where this face sits in the model, for space: "world". up/down faces are
      // a single Y (zero-height sweep) and get a flat sample instead of a ramp.
      const key = op.target.face;
      const lo = Math.min(node.from[1], node.to[1]);
      const hi = Math.max(node.from[1], node.to[1]);
      const worldY: [number, number] = key === 'up' ? [hi, hi] : key === 'down' ? [lo, lo] : [lo, hi];
      geo = {
        rect: [Math.round(x1), Math.round(y1), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))],
        worldY,
        // Blockbench flips v on some box-unwrap faces; a world sweep has to know.
        vFlipped: face.uv[1] > face.uv[3],
        rotated: !!face.rotation,
      };
    } else {
      tex = tex || resolveTexture(undefined);
      map = (pt) => [Math.round(pt[0]), Math.round(pt[1])];
    }
    return { op, tex, map, geo };
  });

  // Group ops per texture (order preserved within each texture).
  const byTexture = new Map<any, PreparedOp[]>();
  for (const p of prepared) {
    if (!byTexture.has(p.tex)) byTexture.set(p.tex, []);
    byTexture.get(p.tex)!.push(p);
  }

  let opCount = 0;
  const paintOps = (canvas: HTMLCanvasElement, env: any, list: PreparedOp[]) => {
    const ctx: CanvasRenderingContext2D = env.ctx;
    ctx.save();
    try {
    ctx.imageSmoothingEnabled = false;
    for (const { op, map, geo } of list) {
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
        if (op.filled === false) {
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
            if (op.filled === false) {
              const nx2 = (x + 0.5 - cx) / (rx - 1 || 0.5), ny2 = (y + 0.5 - cy) / (ry - 1 || 0.5);
              if (d <= 1 && nx2 * nx2 + ny2 * ny2 > 1) ctx.fillRect(x, y, 1, 1);
            } else if (d <= 1) {
              ctx.fillRect(x, y, 1, 1);
            }
          }
        }
      } else if (op.type === 'fill') {
        const [sx, sy] = px(op.at);
        floodFill(ctx, canvas, sx, sy, color, op.opacity ?? 1, op.tolerance ?? 0);
      } else if (op.type === 'gradient') {
        const stops: GradientStop[] = Array.isArray(op.stops) && op.stops.length
          ? op.stops
          : [{ at: 0, color: op.color || '#000000' }, { at: 1, color: op.color2 || 'rgba(0,0,0,0)' }];
        const addStops = (grad: CanvasGradient) => {
          for (const s of stops) grad.addColorStop(Math.max(0, Math.min(1, s.at)), stopColor(s));
        };

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
          opCount++;
          continue;
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
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
      } else if (op.type === 'clear') {
        const [x0, y0] = px(op.from), [x1, y1] = px(op.to);
        ctx.clearRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) + 1, Math.abs(y1 - y0) + 1);
      } else if (op.type === 'jagged_edge' || op.type === 'noise' || op.type === 'strands') {
        const from = op.from ?? [0, 0];
        // No target and no rect means the whole bitmap — speckling an entire
        // atlas in one op is the common case. A targeted op spans its face.
        const to = op.to ?? (op.target ? [1, 1] : [canvas.width - 1, canvas.height - 1]);
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
      opCount++;
    }
    } finally {
      ctx.restore();
    }
  };

  const textures = [...byTexture.keys()];
  Undo.initEdit({ textures, bitmap: true });
  try {
    for (const [tex, list] of byTexture) {
      tex.edit((canvas: HTMLCanvasElement, env: any) => paintOps(canvas, env, list), { no_undo: true });
    }
  } catch (err) {
    // Revert any partially painted pixels and drop the dangling undo entry.
    Undo.cancelEdit(true);
    throw err;
  }
  Undo.finishEdit('MCP: Paint texture');
  UVEditor.vue?.updateTextureCanvas?.();
  return {
    painted: true,
    ops_applied: opCount,
    ops_requested: params.ops.length,
    expanded: opCount !== params.ops.length ? `${params.ops.length} op(s) expanded to ${opCount} face op(s)` : undefined,
    textures: textures.map((t: any) => t.name),
  };
});

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

/**
 * Paint whole cube faces with solid colors — "paint this face of this cube
 * this color" without computing UV rects by hand. Groups recurse into cubes.
 */
register('paint_faces', (params) => {
  requireProject();
  if (!Array.isArray(params.targets) || !params.targets.length) {
    fail('Pass "targets": [{element (cube or group), faces?: ["north",...] | "all", color, opacity?}].');
  }
  const fallbackTex = params.texture ? resolveTexture(params.texture) : null;
  const jobs = new Map<any, { face: any; color: string; opacity: number; label: string }[]>();
  const skipped: string[] = [];
  const painted: string[] = [];

  for (const target of params.targets) {
    if (!target.color) fail('Each target needs a "color" (CSS string).');
    const cubes = collectCubes(target.element, 'paint_faces');
    for (const cube of cubes) {
      const keys: string[] = !target.faces || target.faces === 'all' ? Object.keys(cube.faces) : target.faces;
      for (const fkey of keys) {
        const face = cube.faces[fkey];
        if (!face) fail(`Cube "${cube.name}" has no face "${fkey}". Valid: north, south, east, west, up, down.`);
        if (face.texture === null || face.enabled === false) continue; // hidden face
        const tex = face.getTexture?.() || fallbackTex;
        if (!tex) {
          skipped.push(`${cube.name}.${fkey} (no texture — pass "texture" as fallback)`);
          continue;
        }
        if (!jobs.has(tex)) jobs.set(tex, []);
        jobs.get(tex)!.push({ face, color: target.color, opacity: target.opacity ?? 1, label: `${cube.name}.${fkey}` });
      }
    }
  }
  if (!jobs.size) fail(`No paintable faces found.${skipped.length ? ` Skipped: ${skipped.join(', ')}` : ''}`);

  const textures = [...jobs.keys()];
  Undo.initEdit({ textures, bitmap: true });
  for (const [tex, list] of jobs) {
    tex.edit((canvas: HTMLCanvasElement, env: any) => {
      const ctx: CanvasRenderingContext2D = env.ctx;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      const fx = tex.width / tex.getUVWidth();
      const fy = tex.height / tex.getUVHeight();
      for (const job of list) {
        const x = Math.round(Math.min(job.face.uv[0], job.face.uv[2]) * fx);
        const y = Math.round(Math.min(job.face.uv[1], job.face.uv[3]) * fy);
        const w = Math.max(1, Math.round(Math.abs(job.face.uv[2] - job.face.uv[0]) * fx));
        const h = Math.max(1, Math.round(Math.abs(job.face.uv[3] - job.face.uv[1]) * fy));
        ctx.globalAlpha = 1;
        if (job.opacity >= 1) ctx.clearRect(x, y, w, h); // solid overwrite, no blending with old pixels
        ctx.globalAlpha = job.opacity;
        ctx.fillStyle = job.color;
        ctx.fillRect(x, y, w, h);
        painted.push(job.label);
      }
      ctx.restore();
    }, { no_undo: true });
  }
  Undo.finishEdit('MCP: Paint faces');
  UVEditor.vue?.updateTextureCanvas?.();
  return {
    painted: painted.length,
    faces: painted.slice(0, 80),
    skipped: skipped.length ? skipped : undefined,
    note: 'Faces sharing UV rects (texture reuse) are painted together — check with get_texture.',
  };
});

register('resize_texture', (params) => {
  requireProject();
  const texture = resolveTexture(params.texture);
  const width = clampInt(params.width, 1, 4096);
  const height = clampInt(params.height, 1, 4096);
  Undo.initEdit({ textures: [texture], bitmap: true });
  const old = document.createElement('canvas');
  old.width = texture.canvas.width;
  old.height = texture.canvas.height;
  old.getContext('2d')!.drawImage(texture.canvas, 0, 0);
  texture.edit((canvas: HTMLCanvasElement, env: any) => {
    canvas.width = width;
    canvas.height = height;
    const ctx = env.ctx as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;
    if (params.stretch !== false) {
      ctx.drawImage(old, 0, 0, width, height);
    } else {
      ctx.drawImage(old, 0, 0);
    }
  }, { no_undo: true });
  texture.width = width;
  texture.height = height;
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
