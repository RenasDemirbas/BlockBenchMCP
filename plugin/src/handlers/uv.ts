// UV mapping: per-face cube UV, box UV, mesh UV, auto-UV.
import { register, fail, requireProject } from '../registry';
import { resolveNode, resolveTexture, clampInt, FACE_KEYS } from '../util';

register('set_cube_uv', (params) => {
  requireProject();
  if (!Array.isArray(params.cubes) || !params.cubes.length) {
    fail('Pass a "cubes" array: [{id, box_uv?, uv_offset?, mirror_uv?, faces?: {north: {uv: [x1,y1,x2,y2], rotation?, texture?}, ...}}]');
  }
  const cubes = params.cubes.map((def: any) => {
    const node = resolveNode(def.id);
    if (!(node instanceof Cube)) fail(`"${def.id}" is a ${node.type}, not a cube.`);
    return node;
  });
  Undo.initEdit({ elements: cubes, uv_only: true });
  params.cubes.forEach((def: any, i: number) => {
    const cube = cubes[i];
    if (def.box_uv != null && def.box_uv !== cube.box_uv) cube.setUVMode(def.box_uv);
    if (def.uv_offset) {
      cube.uv_offset[0] = def.uv_offset[0];
      cube.uv_offset[1] = def.uv_offset[1];
    }
    if (def.mirror_uv != null) cube.mirror_uv = def.mirror_uv;
    if (def.faces) {
      if (cube.box_uv) fail(`Cube "${cube.name}" uses box UV — per-face UVs are auto-derived. Set box_uv: false first (in the same call) to use per-face UVs.`);
      for (const fkey in def.faces) {
        const face = cube.faces[fkey];
        if (!face) fail(`Invalid face "${fkey}". Valid: north, south, east, west, up, down.`);
        const fd = def.faces[fkey];
        if (fd.uv) face.uv = fd.uv.slice();
        if (fd.rotation != null) {
          if (![0, 90, 180, 270].includes(fd.rotation)) fail('Face UV rotation must be 0, 90, 180 or 270.');
          face.rotation = fd.rotation;
        }
        if (fd.texture !== undefined) {
          face.extend({ texture: fd.texture === null || fd.texture === false ? fd.texture : resolveTexture(fd.texture).uuid });
        }
      }
    }
  });
  Canvas.updateView({ elements: cubes, element_aspects: { uv: true, faces: true } });
  Undo.finishEdit('MCP: Edit cube UV', { elements: cubes, uv_only: true });
  return { updated: cubes.map((c: any) => c.name) };
});

register('set_mesh_uv', (params) => {
  requireProject();
  const mesh = resolveNode(params.mesh);
  if (!(mesh instanceof Mesh)) fail(`"${params.mesh}" is not a mesh.`);
  if (!params.faces || typeof params.faces !== 'object') {
    fail('Pass "faces": {face_key: {vertex_key: [u, v], ...}, ...}. Get face/vertex keys from get_element.');
  }
  Undo.initEdit({ elements: [mesh], uv_only: true });
  for (const fkey in params.faces) {
    const face = mesh.faces[fkey];
    if (!face) fail(`Mesh has no face "${fkey}". Use get_element to list face keys.`);
    const uvs = params.faces[fkey];
    for (const vkey in uvs) {
      if (!face.vertices.includes(vkey)) fail(`Face "${fkey}" has no vertex "${vkey}" (vertices: ${face.vertices.join(', ')}).`);
      face.uv[vkey] = [uvs[vkey][0], uvs[vkey][1]];
    }
  }
  mesh.preview_controller.updateUV(mesh);
  Undo.finishEdit('MCP: Edit mesh UV', { elements: [mesh], uv_only: true });
  return { updated: mesh.name, faces: Object.keys(params.faces).length };
});

register('auto_uv', (params) => {
  requireProject();
  const nodes = Array.isArray(params.elements) && params.elements.length
    ? params.elements.map((id: string) => resolveNode(id))
    : Project.elements;
  const elements: any[] = [];
  const collect = (n: any) => {
    if (n.faces) elements.push(n);
    n.children?.forEach(collect);
  };
  nodes.forEach(collect);
  if (!elements.length) fail('No elements with faces found to auto-UV.');
  Undo.initEdit({ elements, uv_only: true });
  const cubes = elements.filter((e) => e instanceof Cube && !e.box_uv);
  const meshes = elements.filter((e) => e instanceof Mesh);
  cubes.forEach((cube) => cube.mapAutoUV());
  if (meshes.length) {
    unselectAllElements();
    meshes.forEach((m) => m.markAsSelected());
    updateSelection();
    for (const mesh of meshes) {
      try { UVEditor.setAutoSize(null, true, Object.keys(mesh.faces)); } catch {}
    }
  }
  Canvas.updateAllUVs();
  Undo.finishEdit('MCP: Auto UV', { elements, uv_only: true });
  return { updated: elements.map((e) => e.name), note: elements.some((e: any) => e.box_uv) ? 'Box-UV cubes were skipped (their UVs derive from uv_offset).' : undefined };
});

/** Face size in model units, so a UV rect can be checked for stretching. */
function faceDims(el: any, key: string): [number, number] {
  const sx = Math.abs(el.to[0] - el.from[0]);
  const sy = Math.abs(el.to[1] - el.from[1]);
  const sz = Math.abs(el.to[2] - el.from[2]);
  if (key === 'north' || key === 'south') return [sx, sy];
  if (key === 'east' || key === 'west') return [sz, sy];
  return [sx, sz];
}

register('inspect_uv', (params) => {
  requireProject();
  const only = params.texture ? resolveTexture(params.texture) : null;
  const maxSamples = clampInt(params.max_samples ?? 6, 1, 40);
  const scanPixels = params.scan_pixels !== false;

  // One ImageData read per texture, then index into it — 330 getImageData calls
  // would be needlessly slow on a big model.
  const bitmaps = new Map<any, { data: any; w: number; h: number } | null>();
  const bitmapOf = (tex: any) => {
    if (bitmaps.has(tex)) return bitmaps.get(tex)!;
    let entry: { data: any; w: number; h: number } | null = null;
    try {
      const cv = tex.canvas;
      if (cv && cv.width && cv.height) {
        entry = { data: cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height };
      }
    } catch {
      entry = null; // tainted or not yet decoded — pixel checks are skipped
    }
    bitmaps.set(tex, entry);
    return entry;
  };

  const cubes = (Project.elements as any[]).filter((el) => el instanceof Cube);
  const meshCount = (Project.elements as any[]).filter((el) => el instanceof Mesh).length;

  const rotation: Record<string, number> = {};
  const mirroredU: Record<string, number> = {};
  const mirroredV: Record<string, number> = {};
  const rotatedSamples: string[] = [];
  const swapped: string[] = [];
  const stretched: string[] = [];
  const noTexture: string[] = [];
  const holed: { face: string; transparent_px: number; pct: number }[] = [];
  const rectGroups = new Map<string, string[]>();
  const perTexture = new Map<any, { faces: number; maxU: number; maxV: number; painted: number }>();
  let faces = 0, boxUv = 0;

  for (const cube of cubes) {
    if (cube.box_uv) boxUv++;
    for (const key of FACE_KEYS) {
      const face = cube.faces?.[key];
      if (!face || !face.uv) continue;
      faces++;
      const label = `${cube.name}.${key}`;
      const rot = String(face.rotation || 0);
      rotation[rot] = (rotation[rot] || 0) + 1;
      if (face.rotation) { if (rotatedSamples.length < maxSamples) rotatedSamples.push(`${label}=${face.rotation}deg`); }
      if (face.uv[0] > face.uv[2]) mirroredU[key] = (mirroredU[key] || 0) + 1;
      if (face.uv[1] > face.uv[3]) mirroredV[key] = (mirroredV[key] || 0) + 1;

      const tex = face.getTexture?.() || null;
      if (!tex) { if (noTexture.length < maxSamples) noTexture.push(label); continue; }
      if (only && tex !== only) continue;

      const uw = Math.abs(face.uv[2] - face.uv[0]);
      const uh = Math.abs(face.uv[3] - face.uv[1]);
      const [fw, fh] = faceDims(cube, key);
      // A template lays each face out at a constant units→UV ratio; compare the
      // rect's aspect with the face's to catch rotated or stretched mappings.
      const aspectUv = uh ? uw / uh : 0;
      const aspectFace = fh ? fw / fh : 0;
      if (aspectFace > 0 && aspectUv > 0) {
        const direct = Math.abs(aspectUv - aspectFace) / aspectFace;
        const swap = Math.abs(aspectUv - 1 / aspectFace) / (1 / aspectFace);
        if (direct > 0.08 && swap <= 0.08) { if (swapped.length < maxSamples) swapped.push(`${label} uv=${+uw.toFixed(2)}x${+uh.toFixed(2)} face=${fw}x${fh}`); }
        else if (direct > 0.08) { if (stretched.length < maxSamples) stretched.push(`${label} uv=${+uw.toFixed(2)}x${+uh.toFixed(2)} face=${fw}x${fh}`); }
      }

      const rectKey = `${tex.uuid}|${[Math.min(face.uv[0], face.uv[2]), Math.min(face.uv[1], face.uv[3]), uw, uh].map((v) => Math.round(v * 100) / 100).join(',')}`;
      if (!rectGroups.has(rectKey)) rectGroups.set(rectKey, []);
      rectGroups.get(rectKey)!.push(label);

      const agg = perTexture.get(tex) || { faces: 0, maxU: 0, maxV: 0, painted: 0 };
      agg.faces++;
      agg.maxU = Math.max(agg.maxU, face.uv[0], face.uv[2]);
      agg.maxV = Math.max(agg.maxV, face.uv[1], face.uv[3]);
      perTexture.set(tex, agg);

      if (!scanPixels) continue;
      const bmp = bitmapOf(tex);
      if (!bmp) continue;
      const fx = tex.width / tex.getUVWidth(), fy = tex.height / tex.getUVHeight();
      const x0 = Math.max(0, Math.round(Math.min(face.uv[0], face.uv[2]) * fx));
      const y0 = Math.max(0, Math.round(Math.min(face.uv[1], face.uv[3]) * fy));
      const w = Math.min(bmp.w - x0, Math.max(1, Math.round(uw * fx)));
      const h = Math.min(bmp.h - y0, Math.max(1, Math.round(uh * fy)));
      let clear = 0, n = 0;
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          n++;
          if (bmp.data[((y0 + yy) * bmp.w + (x0 + xx)) * 4 + 3] === 0) clear++;
        }
      }
      if (clear > 0 && holed.length < maxSamples * 3) holed.push({ face: label, transparent_px: clear, pct: Math.round((100 * clear) / (n || 1)) });
    }
  }

  const shared = [...rectGroups.entries()].filter(([, v]) => v.length > 1);
  const sharedFaces = shared.reduce((sum, [, v]) => sum + v.length, 0);
  holed.sort((a, b) => b.pct - a.pct);

  const textures = [...perTexture.entries()].map(([tex, agg]) => {
    const usedArea = agg.maxU * agg.maxV;
    const uvArea = tex.getUVWidth() * tex.getUVHeight();
    return {
      name: tex.name,
      bitmap: [tex.width, tex.height],
      uv_size: [tex.getUVWidth(), tex.getUVHeight()],
      pixels_per_uv_unit: [+(tex.width / tex.getUVWidth()).toFixed(3), +(tex.height / tex.getUVHeight()).toFixed(3)],
      faces: agg.faces,
      used_uv_extent: [+agg.maxU.toFixed(2), +agg.maxV.toFixed(2)],
      uv_area_used_pct: uvArea ? Math.round((100 * usedArea) / uvArea) : null,
    };
  });

  const findings: { level: string; type: string; message: string }[] = [];
  if (noTexture.length) {
    findings.push({ level: 'error', type: 'face_without_texture', message: `${noTexture.length}+ face(s) have no texture assigned (e.g. ${noTexture.slice(0, 3).join(', ')}). They render untextured — assign one with apply_texture.` });
  }
  if (holed.length) {
    findings.push({ level: 'error', type: 'transparent_inside_face', message: `${holed.length}+ face(s) contain fully transparent pixels inside their UV rect (worst: ${holed[0].face} ${holed[0].pct}%). Those areas render see-through.` });
  }
  if (shared.length) {
    findings.push({ level: 'warn', type: 'shared_uv_rect', message: `${shared.length} UV rect(s) are shared by ${sharedFaces} faces — painting one repaints all of them. Run generate_texture_template to give every face its own space.` });
  }
  if (rotatedSamples.length) {
    findings.push({ level: 'warn', type: 'rotated_uv', message: `Face UV rotation is in use (${rotatedSamples.slice(0, 3).join(', ')}). Normalized paint coordinates land rotated on those faces.` });
  }
  if (swapped.length) {
    findings.push({ level: 'warn', type: 'uv_axes_swapped', message: `${swapped.length}+ face rect(s) have their axes swapped relative to the face (e.g. ${swapped[0]}) — the texture appears turned 90° there.` });
  }
  if (stretched.length) {
    findings.push({ level: 'warn', type: 'uv_stretched', message: `${stretched.length}+ face rect(s) do not match the face aspect (e.g. ${stretched[0]}) — pixels are stretched.` });
  }
  for (const t of textures) {
    if (t.uv_area_used_pct !== null && t.uv_area_used_pct < 40) {
      findings.push({ level: 'info', type: 'atlas_underused', message: `"${t.name}": UVs only reach ${t.used_uv_extent.join('x')} of ${t.uv_size.join('x')} (~${t.uv_area_used_pct}% used). A lower pixel_density would waste less space.` });
    }
    if (t.pixels_per_uv_unit[0] !== 1) {
      findings.push({ level: 'info', type: 'uv_scale', message: `"${t.name}": bitmap is ${t.bitmap.join('x')} over a ${t.uv_size.join('x')} UV grid — ${t.pixels_per_uv_unit[0]} bitmap pixels per UV unit. Absolute paint coordinates are in BITMAP pixels.` });
    }
  }

  return {
    project_uv_size: [Project.texture_width, Project.texture_height],
    cubes: cubes.length,
    faces,
    box_uv_cubes: boxUv,
    meshes_skipped: meshCount || undefined,
    textures,
    rotation_counts: rotation,
    mirrored_u_by_face: mirroredU,
    mirrored_v_by_face: mirroredV,
    shared_uv_rects: shared.length ? { groups: shared.length, faces: sharedFaces, samples: shared.slice(0, maxSamples).map(([k, v]) => ({ rect: k.split('|')[1], count: v.length, faces: v.slice(0, 6) })) } : undefined,
    faces_without_texture: noTexture.length ? noTexture : undefined,
    axes_swapped: swapped.length ? swapped : undefined,
    stretched: stretched.length ? stretched : undefined,
    rotated: rotatedSamples.length ? rotatedSamples : undefined,
    transparent_inside_faces: holed.length ? holed.slice(0, maxSamples) : undefined,
    findings,
    note: findings.length ? undefined : 'No UV mapping problems found — every face has its own opaque, correctly-proportioned rect.',
  };
});
