// paint_texture (declarative pixel ops) and paint_faces (solid face colours).
import { register, fail, requireProject } from '../registry';
import { resolveNode, resolveTexture, FACE_KEYS } from '../util';
import { paintTarget, commitBitmap } from './layers';
import { collectSurfaceElements, surfaceFaces, faceMask, forEachTexel, targetFaceKeys, SurfaceFace } from '../surface';
import { drawPaintOp, PaintGeo } from './paintops';

type PreparedOp = {
  op: any;
  map: (pt: number[]) => [number, number];
  geo: PaintGeo;
};

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
    for (const f of surfaceFaces(Mesh.all)) {
      for (const p of f.world) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
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
    if (t.faces !== 'all' && (!Array.isArray(t.faces) || !t.faces.length)) fail(`ops[${i}]: "target.faces" must be "all" or a non-empty array of face keys.`);
    const els = collectSurfaceElements(t.element, `ops[${i}]`);
    let matched = 0;
    for (const el of els) {
      for (const k of targetFaceKeys(el, t.faces)) {
        const face = el.faces[k];
        if (!face) continue;
        if (face.texture === null || face.enabled === false) continue; // hidden face
        matched++;
        expandedOps.push({ ...op, target: { element: el.uuid, face: k } });
      }
    }
    if (!matched && t.faces !== 'all') {
      fail(`ops[${i}]: no face matched ${JSON.stringify(t.faces)}. Cube faces: ${FACE_KEYS.join(', ')}; mesh faces: their keys (get_element) or a direction name, which picks the faces pointing that way.`);
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
      if (node instanceof Mesh) {
        let key = op.target.face;
        if (!node.faces[key]) {
          const keys = FACE_KEYS.includes(key) ? targetFaceKeys(node, [key]) : [];
          if (keys.length !== 1) fail(`Mesh "${node.name}" has ${keys.length ? `${keys.length} faces pointing ${key}` : `no face "${key}"`} — use "faces" (plural) to paint several, or a face key from get_element.`);
          key = keys[0];
        }
        const surf = surfaceFaces([node], { faces: [key], texture: explicitTexture || undefined })[0]
          || surfaceFaces([node], { faces: [key] })[0];
        if (!surf) fail(`Mesh face "${node.name}.${key}" has no texture assigned. Assign one (apply_texture) or pass "texture".`);
        if (explicitTexture && surf.tex !== explicitTexture) {
          fail(`Face "${node.name}.${key}" is mapped to texture "${surf.tex.name}", not "${explicitTexture.name}" — omit "texture" or pass the face's own texture.`);
        }
        tex = surf.tex;
        const mask = faceMask(surf, 'conservative');
        if (!mask.count) fail(`Mesh face "${node.name}.${key}" covers no texel centre (its UV polygon is degenerate or under 1 px). Run unwrap_mesh (or generate_texture_template) first.`);
        // Normalized 0-1 spans the UV polygon's own bounds (the mask is a
        // texel wider all round so border texels get painted too).
        const pxs = surf.px.map((p) => p[0]), pys = surf.px.map((p) => p[1]);
        const bx = Math.floor(Math.min(...pxs)), by = Math.floor(Math.min(...pys));
        const bw = Math.max(1, Math.ceil(Math.max(...pxs)) - bx), bh = Math.max(1, Math.ceil(Math.max(...pys)) - by);
        map = (pt) => [Math.round(bx + pt[0] * bw), Math.round(by + pt[1] * bh)];
        const ys = surf.world.map((p) => p[1]);
        geo = {
          rect: [bx, by, bw, bh],
          worldY: [Math.min(...ys), Math.max(...ys)],
          vFlipped: false,
          rotated: false,
          mask,
          surf,
        };
        return { op, tex, map, geo };
      }
      if (!(node instanceof Cube)) fail(`paint ops "target" supports cube and mesh faces; "${node.name}" is a ${node.type}.`);
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
  const paintOps = (target: { canvas: any; ctx: any; offset: [number, number] }, tex: any, list: PreparedOp[]) => {
    const { canvas } = target;
    const ctx: CanvasRenderingContext2D = target.ctx;
    // Ops speak TEXTURE pixels, but a layer can sit at an offset and be
    // smaller than the texture — shift the context so both line up.
    const [ox, oy] = target.offset;
    const texW = tex.width, texH = tex.height;
    ctx.save();
    try {
    ctx.imageSmoothingEnabled = false;
    ctx.translate(-ox, -oy);
    for (const { op, map, geo } of list) {
      const m = geo?.mask;
      const before = m ? ctx.getImageData(m.x - ox, m.y - oy, m.w, m.h) : null;
      drawPaintOp(ctx, op, map, geo, { canvas, ox, oy, texW, texH, modelY });
      if (m && before) {
        // Revert every pixel of the face's bounding rect that is not inside
        // its UV polygon — pixel-exact clipping without anti-aliased edges.
        const after = ctx.getImageData(m.x - ox, m.y - oy, m.w, m.h);
        for (let i = 0; i < m.bits.length; i++) {
          if (m.bits[i]) continue;
          const j = i * 4;
          after.data[j] = before.data[j]; after.data[j + 1] = before.data[j + 1];
          after.data[j + 2] = before.data[j + 2]; after.data[j + 3] = before.data[j + 3];
        }
        ctx.putImageData(after, m.x - ox, m.y - oy);
      }
      opCount++;
    }
    } finally {
      ctx.restore();
    }
  };

  const textures = [...byTexture.keys()];
  const layersUsed: string[] = [];
  const layersCreated: string[] = [];
  Undo.initEdit({ textures, bitmap: true });
  try {
    for (const [tex, list] of byTexture) {
      const target = paintTarget(tex, params.layer);
      if (target.layer) layersUsed.push(`${tex.name} → ${target.layer.name}`);
      if (target.created) layersCreated.push(`${tex.name} → ${target.layer.name}`);
      paintOps(target, tex, list);
      commitBitmap(tex);
    }
  } catch (err) {
    // Revert any partially painted pixels and drop the dangling undo entry.
    Undo.cancelEdit(true);
    throw err;
  }
  Undo.finishEdit('MCP: Paint texture', { textures, bitmap: true });
  UVEditor.vue?.updateTextureCanvas?.();
  return {
    painted: true,
    ops_applied: opCount,
    ops_requested: params.ops.length,
    expanded: opCount !== params.ops.length ? `${params.ops.length} op(s) expanded to ${opCount} face op(s)` : undefined,
    textures: textures.map((t: any) => t.name),
    layer: layersUsed.length ? layersUsed : undefined,
    layers_created: layersCreated.length ? layersCreated : undefined,
  };
});

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
  const jobs = new Map<any, { face: any; surf?: SurfaceFace; color: string; opacity: number; label: string }[]>();
  const skipped: string[] = [];
  const painted: string[] = [];

  for (const target of params.targets) {
    if (!target.color) fail('Each target needs a "color" (CSS string).');
    const els = collectSurfaceElements(target.element, 'paint_faces');
    for (const cube of els) {
      const wanted = !target.faces || target.faces === 'all' ? 'all' : target.faces;
      if (cube instanceof Cube && wanted !== 'all') {
        for (const k of wanted) if (!cube.faces[k]) fail(`Cube "${cube.name}" has no face "${k}". Valid: north, south, east, west, up, down.`);
      }
      const keys = targetFaceKeys(cube, wanted);
      for (const fkey of keys) {
        const face = cube.faces[fkey];
        if (!face) continue;
        if (face.texture === null || face.enabled === false) continue; // hidden face
        const surf = cube instanceof Mesh ? surfaceFaces([cube], { faces: [fkey], texture: fallbackTex || undefined })[0] : undefined;
        const tex = surf?.tex || face.getTexture?.() || fallbackTex;
        if (!tex) {
          skipped.push(`${cube.name}.${fkey} (no texture — pass "texture" as fallback)`);
          continue;
        }
        if (!jobs.has(tex)) jobs.set(tex, []);
        jobs.get(tex)!.push({ face, surf, color: target.color, opacity: target.opacity ?? 1, label: `${cube.name}.${fkey}` });
      }
    }
  }
  if (!jobs.size) fail(`No paintable faces found.${skipped.length ? ` Skipped: ${skipped.join(', ')}` : ''}`);

  const textures = [...jobs.keys()];
  const layersCreated: string[] = [];
  Undo.initEdit({ textures, bitmap: true });
  try {
    for (const [tex, list] of jobs) {
      const target = paintTarget(tex, params.layer);
      if (target.created) layersCreated.push(`${tex.name} → ${target.layer.name}`);
      const ctx: CanvasRenderingContext2D = target.ctx;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.translate(-target.offset[0], -target.offset[1]);
      const fx = tex.width / tex.getUVWidth();
      const fy = tex.height / tex.getUVHeight();
      for (const job of list) {
        if (job.surf) {
          // Mesh face: fill exactly the texels inside its UV polygon.
          const surf = job.surf;
          forEachTexel(surf, (x, y) => {
            ctx.globalAlpha = 1;
            if (job.opacity >= 1) ctx.clearRect(x, y, 1, 1);
            ctx.globalAlpha = job.opacity;
            ctx.fillStyle = job.color;
            ctx.fillRect(x, y, 1, 1);
          }, 'conservative');
          painted.push(job.label);
          continue;
        }
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
      commitBitmap(tex);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  Undo.finishEdit('MCP: Paint faces', { textures, bitmap: true });
  UVEditor.vue?.updateTextureCanvas?.();
  return {
    painted: painted.length,
    faces: painted.slice(0, 80),
    skipped: skipped.length ? skipped : undefined,
    layers_created: layersCreated.length ? layersCreated : undefined,
    note: 'Faces sharing UV rects (texture reuse) are painted together — check with get_texture.',
  };
});
