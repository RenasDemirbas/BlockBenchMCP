// Seam blending — what Blockbench 5.2's screen-space brush is for, done in
// world space: texels near the edge of a face are averaged with the texels
// that lie next to them IN 3D, including those of the neighbouring face on the
// other side of a UV seam or cube edge. Both sides drift toward a shared
// colour at the seam, fading back to their own colour `width` texels in.
//
// Pure data in, data out: the handler collects samples from the surface and
// writes the result back.

export interface SeamSamples {
  count: number;
  /** World position, xyz per sample. */
  pos: Float32Array;
  /** Unit world normal, xyz per sample. */
  normal: Float32Array;
  /** Colour, rgba per sample. */
  rgba: Uint8ClampedArray;
  face: Int32Array;
  element: Int32Array;
  /** Distance to the face's own border, in texels. */
  edge: Float32Array;
  /** World size of one texel on this sample's face. */
  texel: Float32Array;
}

export interface SeamOptions {
  /** Blend zone, in texels from the seam. */
  width: number;
  /** 0-1: how far texels right at the seam move toward the shared colour. */
  strength: number;
  /** Faces meeting at a sharper angle than this are not blended. */
  maxAngle: number;
  /** "faces": every face edge; "elements": only where different cubes/meshes meet. */
  between: 'faces' | 'elements';
  /** Skip transparent texels (they neither blend nor contribute). */
  onlyPainted: boolean;
}

export interface SeamResult {
  /** Sample index → blended rgba, for samples that changed. */
  changed: Map<number, [number, number, number, number]>;
  /** Faces that had at least one blended texel. */
  faces: Set<number>;
}

const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

export function blendSeams(s: SeamSamples, o: SeamOptions): SeamResult {
  const changed: SeamResult['changed'] = new Map();
  const faces = new Set<number>();
  if (!s.count) return { changed, faces };

  // Uniform grid sized to the largest search radius: every neighbour of a
  // sample is in its own cell or one of the 26 around it.
  let cell = 0;
  for (let i = 0; i < s.count; i++) cell = Math.max(cell, s.texel[i] * o.width);
  cell = Math.max(cell, 1e-4);
  const grid = new Map<string, number[]>();
  const cellOf = (i: number) => [Math.floor(s.pos[i * 3] / cell), Math.floor(s.pos[i * 3 + 1] / cell), Math.floor(s.pos[i * 3 + 2] / cell)];
  for (let i = 0; i < s.count; i++) {
    if (o.onlyPainted && s.rgba[i * 4 + 3] === 0) continue;
    const [x, y, z] = cellOf(i);
    const key = cellKey(x, y, z);
    let list = grid.get(key);
    if (!list) grid.set(key, (list = []));
    list.push(i);
  }

  const cosLimit = Math.cos((o.maxAngle * Math.PI) / 180);
  for (let i = 0; i < s.count; i++) {
    if (s.edge[i] >= o.width) continue;
    if (o.onlyPainted && s.rgba[i * 4 + 3] === 0) continue;
    const radius = s.texel[i] * o.width;
    const [cx, cy, cz] = cellOf(i);
    let wSum = 0, r = 0, g = 0, b = 0, a = 0;
    let across = false;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
      if (!list) continue;
      for (const j of list) {
        const sameFace = s.face[j] === s.face[i];
        if (!sameFace) {
          if (o.between === 'elements' && s.element[j] === s.element[i]) continue;
          const cos = s.normal[i * 3] * s.normal[j * 3] + s.normal[i * 3 + 1] * s.normal[j * 3 + 1] + s.normal[i * 3 + 2] * s.normal[j * 3 + 2];
          if (cos < cosLimit) continue;
        }
        const d = Math.hypot(s.pos[j * 3] - s.pos[i * 3], s.pos[j * 3 + 1] - s.pos[i * 3 + 1], s.pos[j * 3 + 2] - s.pos[i * 3 + 2]);
        if (d > radius) continue;
        if (!sameFace) across = true;
        const w = 1 - d / radius + 1e-3;
        wSum += w;
        r += s.rgba[j * 4] * w; g += s.rgba[j * 4 + 1] * w; b += s.rgba[j * 4 + 2] * w; a += s.rgba[j * 4 + 3] * w;
      }
    }
    // Only a texel with something on the far side of a seam is a seam texel.
    if (!across || wSum <= 0) continue;
    const t = 1 - s.edge[i] / o.width;
    const mix = o.strength * t * t * (3 - 2 * t);
    const own = [s.rgba[i * 4], s.rgba[i * 4 + 1], s.rgba[i * 4 + 2], s.rgba[i * 4 + 3]];
    const avg = [r / wSum, g / wSum, b / wSum, a / wSum];
    const out = own.map((c, k) => Math.round(c + (avg[k] - c) * mix)) as [number, number, number, number];
    if (out.some((c, k) => c !== own[k])) {
      changed.set(i, out);
      faces.add(s.face[i]);
    }
  }
  return { changed, faces };
}
