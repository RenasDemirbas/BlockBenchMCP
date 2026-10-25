// blend_seams: soften the hard colour breaks where faces meet — across UV
// seams on meshes and around the edges and joints of cubes. The world-space
// counterpart of Blockbench 5.2's screen-space brush (see ../texturing/seamblend).
import { register, fail, requireProject } from '../registry';
import { resolveTexture } from '../util';
import { collectSurfaceElements, surfaceFaces, forEachTexel, worldArea, pixelArea, segDist, P2 } from '../surface';
import { paintTarget, commitBitmap } from './layers';
import { blendSeams, SeamSamples } from '../texturing/seamblend';

/** The parts of a canvas ImageData this module reads and writes. */
type PixelBuffer = { data: Uint8ClampedArray; width: number; height: number };

function collectSamples(faces: any[], sources: Map<any, PixelBuffer>): { samples: SeamSamples; where: { tex: any; x: number; y: number }[] } {
  const pos: number[] = [], normal: number[] = [], rgba: number[] = [];
  const face: number[] = [], element: number[] = [], edge: number[] = [], texel: number[] = [];
  const where: { tex: any; x: number; y: number }[] = [];
  const elementIds = new Map<any, number>();
  const seen = new Set<string>();
  faces.forEach((f, fi) => {
    const uvArea = Math.abs(pixelArea(f.px));
    if (uvArea < 0.5) return; // a face squeezed to a line or point on the texture
    const texelSize = Math.sqrt(worldArea(f.world) / uvArea);
    if (!elementIds.has(f.el)) elementIds.set(f.el, elementIds.size);
    const src = sources.get(f.tex)!;
    const border: [P2, P2][] = f.px.map((p: P2, i: number) => [p, f.px[(i + 1) % f.px.length]]);
    forEachTexel(f, (x, y, w) => {
      // A texel shared by two faces (overlapping UVs) is blended once.
      const id = `${f.tex.uuid}:${x},${y}`;
      if (seen.has(id)) return;
      seen.add(id);
      const c: P2 = [x + 0.5, y + 0.5];
      let d = Infinity;
      for (const [a, b] of border) d = Math.min(d, segDist(c, a, b));
      const k = (y * src.width + x) * 4;
      pos.push(w[0], w[1], w[2]);
      normal.push(f.normal[0], f.normal[1], f.normal[2]);
      rgba.push(src.data[k], src.data[k + 1], src.data[k + 2], src.data[k + 3]);
      face.push(fi);
      element.push(elementIds.get(f.el)!);
      edge.push(Math.max(0, d - 0.5));
      texel.push(texelSize);
      where.push({ tex: f.tex, x, y });
    });
  });
  return {
    samples: {
      count: where.length,
      pos: Float32Array.from(pos), normal: Float32Array.from(normal), rgba: Uint8ClampedArray.from(rgba),
      face: Int32Array.from(face), element: Int32Array.from(element), edge: Float32Array.from(edge), texel: Float32Array.from(texel),
    },
    where,
  };
}

register('blend_seams', (params) => {
  requireProject();
  const ids: string[] = Array.isArray(params.elements) && params.elements.length ? params.elements : ['*'];
  const elements = [...new Set(ids.flatMap((id) => collectSurfaceElements(id, 'blend_seams')))];
  const onlyTex = params.texture ? resolveTexture(params.texture) : null;
  const faces = surfaceFaces(elements, onlyTex ? { texture: onlyTex } : {});
  if (!faces.length) fail('No textured faces to blend. Assign a texture (generate_texture_template / unwrap_mesh) first.');
  const between = params.between ?? 'faces';
  if (!['faces', 'elements'].includes(between)) fail('between must be "faces" or "elements".');
  const width = Math.max(0.5, Math.min(16, Number(params.width ?? 2)));
  const strength = Math.max(0, Math.min(1, Number(params.strength ?? 0.75)));

  // Blend from the composited texture, so layered textures blend what is seen.
  const textures = [...new Set(faces.map((f) => f.tex))];
  const sources = new Map<any, PixelBuffer>();
  for (const tex of textures) sources.set(tex, tex.canvas.getContext('2d').getImageData(0, 0, tex.canvas.width, tex.canvas.height));
  const { samples, where } = collectSamples(faces, sources);
  const result = blendSeams(samples, {
    width, strength, between,
    maxAngle: Math.max(0, Math.min(180, Number(params.max_angle ?? 100))),
    onlyPainted: params.only_painted !== false,
  });

  const perTexture: Record<string, number> = {};
  Undo.initEdit({ textures, bitmap: true });
  try {
    const writes = new Map<any, { target: ReturnType<typeof paintTarget>; img: PixelBuffer }>();
    for (const [i, rgba] of result.changed) {
      const { tex, x, y } = where[i];
      let entry = writes.get(tex);
      if (!entry) {
        const target = paintTarget(tex, params.layer);
        entry = { target, img: target.ctx.getImageData(0, 0, target.canvas.width, target.canvas.height) };
        writes.set(tex, entry);
      }
      const tx = x - entry.target.offset[0], ty = y - entry.target.offset[1];
      if (tx < 0 || ty < 0 || tx >= entry.img.width || ty >= entry.img.height) continue;
      entry.img.data.set(rgba, (ty * entry.img.width + tx) * 4);
      perTexture[tex.name] = (perTexture[tex.name] || 0) + 1;
    }
    for (const [tex, { target, img }] of writes) {
      target.ctx.putImageData(img, 0, 0);
      commitBitmap(tex);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  Undo.finishEdit('MCP: Blend seams', { textures, bitmap: true });
  return {
    texels_blended: result.changed.size,
    per_texture: perTexture,
    faces_touched: result.faces.size,
    faces_checked: faces.length,
    settings: { width, strength, between, layer: params.layer },
    note: result.changed.size
      ? 'Check with capture_screenshot. Run it again for a softer transition, or undo and raise "width".'
      : 'Nothing changed: no face edge has a differently coloured neighbour within reach. Raise "width" or "max_angle", or check that the faces actually touch.',
  };
});
