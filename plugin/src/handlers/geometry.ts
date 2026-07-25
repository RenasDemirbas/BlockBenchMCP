// World-space geometry queries and model validation: intersection detection
// (OBB SAT), pose sampling at animation times, lowest-point/ground queries,
// professional-readiness checks.
import { register, fail, requireProject } from '../registry';
import { resolveAnimation, resolveNode, clampInt, textureCoverage } from '../util';

function getScene(): any {
  return Canvas.scene || (window as any).scene;
}

/** Nearest Group ancestor (the bone this element is animated by), or null. */
function boneOf(el: any): any {
  let p = el.parent;
  while (p && p !== 'root') {
    if (p instanceof Group) return p;
    p = p.parent;
  }
  return null;
}

/** World-space corners of an element's oriented bounding box (8 points). */
function worldCorners(el: any): any[] | null {
  const mesh = el.mesh;
  if (!mesh || !mesh.geometry) return null;
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  if (!bb || !isFinite(bb.min.x) || !isFinite(bb.max.x)) return null;
  const corners: any[] = [];
  for (const x of [bb.min.x, bb.max.x]) {
    for (const y of [bb.min.y, bb.max.y]) {
      for (const z of [bb.min.z, bb.max.z]) {
        corners.push(new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld));
      }
    }
  }
  return corners;
}

/**
 * Local axes of an element's mesh in world space. `edges` are the normalized
 * matrix columns (box edge directions); `normals` are the actual face normals
 * (cross products of the raw columns) — these differ under sheared transforms
 * (non-uniform bone scale above a rotated element).
 */
function worldAxes(el: any): { edges: any[]; normals: any[] } {
  const m = el.mesh.matrixWorld;
  const raw = [0, 1, 2].map((i) => new THREE.Vector3().setFromMatrixColumn(m, i));
  const fallback = (i: number) => new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
  const edges = raw.map((v, i) => (v.lengthSq() > 1e-10 ? v.clone().normalize() : fallback(i)));
  const normals = raw.map((_, i) => {
    const n = new THREE.Vector3().crossVectors(raw[(i + 1) % 3], raw[(i + 2) % 3]);
    return n.lengthSq() > 1e-10 ? n.normalize() : edges[i];
  });
  return { edges, normals };
}

function projectOnAxis(corners: any[], axis: any): [number, number] {
  let min = Infinity, max = -Infinity;
  for (const c of corners) {
    const d = c.dot(axis);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

/**
 * SAT overlap test between two OBBs given world corners + axes.
 * Returns the penetration depth (smallest overlap across all axes), or null
 * if a separating axis exists. Classic 15-axis set: 3 face normals of each
 * box plus the 9 edge-edge cross products.
 */
function satPenetration(cornersA: any[], axesA: { edges: any[]; normals: any[] }, cornersB: any[], axesB: { edges: any[]; normals: any[] }): number | null {
  const axes: any[] = [...axesA.normals, ...axesB.normals];
  for (const a of axesA.edges) {
    for (const b of axesB.edges) {
      const cross = new THREE.Vector3().crossVectors(a, b);
      if (cross.lengthSq() > 1e-8) axes.push(cross.normalize());
    }
  }
  let minOverlap = Infinity;
  for (const axis of axes) {
    const [a0, a1] = projectOnAxis(cornersA, axis);
    const [b0, b1] = projectOnAxis(cornersB, axis);
    const overlap = Math.min(a1, b1) - Math.max(a0, b0);
    if (overlap <= 0) return null;
    if (overlap < minOverlap) minOverlap = overlap;
  }
  return minOverlap;
}

interface PoseSpec {
  animation?: string;
  time?: number;
  times?: number[];
}

/**
 * Run `sample` at the rest pose (no animation given) or at each animation
 * time. Fully restores the caller's session afterwards: mode, selected
 * animation, timeline position and the live pose — even when sampling throws.
 */
function samplePoses<T>(spec: PoseSpec, sample: (time: number | null) => T): T[] {
  requireProject();
  const prevMode = Mode.selected?.id;
  const prevAnim = Animation.selected;
  const prevTime = Timeline.time;

  const restore = () => {
    try {
      if (prevMode === 'animate') {
        try { Modes.options.animate.select(); } catch {}
        if (prevAnim) {
          try { prevAnim.select(); } catch {}
          Timeline.setTime(prevTime);
          Animator.preview();
        }
      } else if (prevMode && Mode.selected?.id !== prevMode) {
        try { Modes.options[prevMode]?.select(); } catch {}
      }
      getScene().updateMatrixWorld(true);
    } catch {}
  };

  if (!spec.animation) {
    // Rest pose: leave animate mode so bones return to bind pose.
    const wasAnimate = prevMode === 'animate';
    if (wasAnimate) {
      try { Modes.options.edit.select(); } catch {}
    }
    getScene().updateMatrixWorld(true);
    try {
      return [sample(null)];
    } finally {
      if (wasAnimate) restore();
    }
  }
  if (!Format.animation_mode) fail(`Format "${Format.id}" does not support animations — omit "animation" to inspect the rest pose.`);
  const anim = resolveAnimation(spec.animation);
  try { Modes.options.animate.select(); } catch {}
  anim.select();
  let times: number[];
  if (Array.isArray(spec.times) && spec.times.length) {
    times = spec.times.slice(0, 32);
  } else if (typeof spec.time === 'number') {
    times = [spec.time];
  } else {
    const len = anim.length || anim.getMaxLength() || 1;
    times = Array.from({ length: 8 }, (_, i) => Math.round((i / 7) * len * 1000) / 1000);
  }
  const results: T[] = [];
  try {
    for (const t of times) {
      Timeline.setTime(Math.max(0, t));
      Animator.preview();
      getScene().updateMatrixWorld(true);
      results.push(sample(t));
    }
  } finally {
    restore();
  }
  return results;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function vec3Round(v: any): [number, number, number] {
  return [round3(v.x), round3(v.y), round3(v.z)];
}

// ─────────────────────────── query_geometry ───────────────────────────

register('query_geometry', (params) => {
  requireProject();
  const filter: any[] | null = Array.isArray(params.elements) && params.elements.length
    ? params.elements.map((id: string) => resolveNode(id))
    : null;
  const targets = (filter
    ? filter.flatMap((n: any) => {
      if (n instanceof Group) {
        const els: any[] = [];
        n.forEachChild((c: any) => { if (c.faces) els.push(c); });
        return els;
      }
      return [n];
    })
    : Project.elements
  ).filter((el: any) => (el instanceof Cube || el instanceof Mesh) && el.visibility !== false && el.mesh);

  if (!targets.length) fail('No visible cubes or meshes found to measure. Check "elements" ids with list_outline.');

  // "Multi-time" must mirror samplePoses' actual sweep: an animation with no
  // explicit time(s) samples 8 poses, not one.
  const sweepCount = Array.isArray(params.times) && params.times.length
    ? Math.min(params.times.length, 32)
    : (typeof params.time === 'number' || !params.animation) ? 1 : 8;
  const multiTime = sweepCount > 1;
  const includeElements = params.include_elements ?? (!multiTime && targets.length <= 150);
  const includeBones = params.include_bones ?? !multiTime;

  const samples = samplePoses(params, (time) => {
    const modelBox = new THREE.Box3();
    let lowest: { y: number; at: [number, number, number]; element: string } | null = null;
    let highest: { y: number; element: string } | null = null;
    const elements: any[] = [];

    for (const el of targets) {
      const corners = worldCorners(el);
      if (!corners) continue;
      const box = new THREE.Box3().setFromPoints(corners);
      modelBox.union(box);
      for (const c of corners) {
        if (!lowest || c.y < lowest.y) lowest = { y: round3(c.y), at: vec3Round(c), element: el.name };
        if (!highest || c.y > highest.y) highest = { y: round3(c.y), element: el.name };
      }
      if (includeElements) {
        elements.push({
          name: el.name,
          type: el.type,
          bone: boneOf(el)?.name,
          min: vec3Round(box.min),
          max: vec3Round(box.max),
          center: vec3Round(box.getCenter(new THREE.Vector3())),
        });
      }
    }

    const out: any = {
      time: time ?? undefined,
      model_aabb: {
        min: vec3Round(modelBox.min),
        max: vec3Round(modelBox.max),
        size: vec3Round(modelBox.getSize(new THREE.Vector3())),
        center: vec3Round(modelBox.getCenter(new THREE.Vector3())),
      },
      lowest_point: lowest,
      highest_y: highest?.y,
      ground_clearance: lowest ? lowest.y : undefined,
    };
    if (includeElements) out.elements = elements;
    if (includeBones) {
      out.bones = getAllGroups()
        .filter((g: any) => g.mesh)
        .map((g: any) => ({
          name: g.name,
          world_pivot: vec3Round(g.mesh.getWorldPosition(new THREE.Vector3())),
        }));
    }
    return out;
  });

  const result: any = params.animation
    ? { animation: params.animation, samples, units: '1 unit = 1/16 block; y=0 is the floor' }
    : { ...samples[0], units: '1 unit = 1/16 block; y=0 is the floor' };
  return result;
});

// ─────────────────────────── validate_model ───────────────────────────

function collectIntersections(tolerance: number, includeSameBone: boolean, maxPairs: number): any[] {
  const solids = Project.elements.filter((el: any) =>
    (el instanceof Cube || el instanceof Mesh) && el.visibility !== false && el.mesh);
  const data = solids.map((el: any) => ({
    el,
    corners: worldCorners(el),
    axes: null as { edges: any[]; normals: any[] } | null,
    bone: boneOf(el),
  })).filter((d: any) => d.corners);

  const hits: any[] = [];
  for (let i = 0; i < data.length; i++) {
    for (let j = i + 1; j < data.length; j++) {
      const A = data[i], B = data[j];
      // Only skip pairs sharing a REAL bone — two root-level elements have
      // bone === null on both sides and must still be tested.
      if (!includeSameBone && A.bone && A.bone === B.bone) continue;
      if (!A.axes) A.axes = worldAxes(A.el);
      if (!B.axes) B.axes = worldAxes(B.el);
      const pen = satPenetration(A.corners, A.axes, B.corners, B.axes);
      if (pen != null && pen > tolerance) {
        hits.push({
          a: A.el.name,
          b: B.el.name,
          bone_a: A.bone?.name ?? 'root',
          bone_b: B.bone?.name ?? 'root',
          penetration: round3(pen),
          approx: (A.el instanceof Mesh || B.el instanceof Mesh) ? 'mesh uses bounding-box approximation' : undefined,
        });
      }
    }
  }
  hits.sort((a, b) => b.penetration - a.penetration);
  if (hits.length > maxPairs) {
    const truncated = hits.length;
    hits.length = maxPairs;
    hits.push({ note: `...${truncated - maxPairs} more pairs truncated (raise max_pairs to see all)` });
  }
  return hits;
}

function staticChecks(): { findings: any[]; stats: any } {
  const findings: any[] = [];
  const add = (level: string, type: string, message: string, elements?: string[]) => {
    findings.push({ level, type, message, elements: elements?.slice(0, 20) });
  };

  // Degenerate cubes: 2+ zero-size axes (a plane with one zero axis is legit fur/foliage technique)
  const degenerate = Cube.all.filter((c: any) => {
    const dims = [0, 1, 2].map((i) => Math.abs(c.to[i] - c.from[i]) + 2 * (c.inflate || 0));
    return dims.filter((d) => d < 1e-5).length >= 2;
  });
  if (degenerate.length) add('warning', 'degenerate_cubes', `${degenerate.length} cube(s) have 2+ zero-size axes (line/point cubes render as nothing)`, degenerate.map((c: any) => c.name));

  // Bone-rig: cubes at root won't animate
  if (Format.bone_rig) {
    const rootCubes = Project.elements.filter((el: any) => el.faces && !boneOf(el));
    if (rootCubes.length) add('warning', 'unparented_elements', `${rootCubes.length} element(s) are not inside any group (bone) — they cannot be animated`, rootCubes.map((e: any) => e.name));
  }

  // Fully transparent textures make every face using them invisible — the
  // single most confusing failure mode ("my model/screenshot went blank").
  const blankTextures = Texture.all.filter((t: any) => textureCoverage(t).fully_transparent);
  if (blankTextures.length) {
    add('error', 'transparent_texture',
      `${blankTextures.length} texture(s) are fully transparent (no visible pixels) — faces using them render invisible in Blockbench, in screenshots and in game. Paint them or recreate with a fill_color.`,
      blankTextures.map((t: any) => t.name));
  }

  // Untextured faces — meaningless in single-texture formats (bedrock): faces
  // there render with the project texture whether or not they are assigned.
  if (!Texture.all.length && (Cube.all.length || Mesh.all.length)) {
    add('info', 'no_textures', 'The model has no textures yet. Use generate_texture_template after modeling.');
  } else if (Texture.all.length && !Format.single_texture) {
    const untextured: string[] = [];
    for (const cube of Cube.all) {
      for (const fkey in cube.faces) {
        const face = cube.faces[fkey];
        if (face.texture === false && face.enabled !== false) { untextured.push(`${cube.name}.${fkey}`); break; }
      }
    }
    if (untextured.length) add('warning', 'untextured_faces', `${untextured.length} cube(s) have untextured faces`, untextured);
  }

  // UV bounds
  const uvOOB: string[] = [];
  for (const cube of Cube.all) {
    if (cube.box_uv) {
      const dims = [0, 1, 2].map((i) => Math.abs(cube.to[i] - cube.from[i]));
      const w = 2 * (dims[2] + dims[0]);
      const h = dims[2] + dims[1];
      const uvW = Project.getUVWidth ? Project.getUVWidth() : Project.texture_width;
      const uvH = Project.getUVHeight ? Project.getUVHeight() : Project.texture_height;
      if (cube.uv_offset[0] + w > uvW + 0.01 || cube.uv_offset[1] + h > uvH + 0.01 || cube.uv_offset[0] < -0.01 || cube.uv_offset[1] < -0.01) {
        uvOOB.push(`${cube.name} (box UV ${cube.uv_offset.join(',')} + ${Math.ceil(w)}x${Math.ceil(h)})`);
      }
    } else {
      for (const fkey in cube.faces) {
        const face = cube.faces[fkey];
        if (face.texture === null || face.enabled === false) continue;
        const tex = face.getTexture?.();
        const uvW = tex?.getUVWidth?.() ?? Project.texture_width;
        const uvH = tex?.getUVHeight?.() ?? Project.texture_height;
        const [u0, v0, u1, v1] = face.uv;
        if (Math.min(u0, u1) < -0.01 || Math.min(v0, v1) < -0.01 || Math.max(u0, u1) > uvW + 0.01 || Math.max(v0, v1) > uvH + 0.01) {
          uvOOB.push(`${cube.name}.${fkey}`);
        }
      }
    }
  }
  if (uvOOB.length) add('warning', 'uv_out_of_bounds', `${uvOOB.length} face UV(s) extend beyond the texture UV size`, uvOOB);

  // Duplicate bone names break bedrock export
  if (Format.bone_rig) {
    const seen = new Map<string, number>();
    for (const g of getAllGroups()) seen.set(g.name, (seen.get(g.name) || 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([name, n]) => `${name} ×${n}`);
    if (dupes.length) add('error', 'duplicate_bone_names', 'Duplicate bone (group) names break bedrock export and name-based tools', dupes);
  }

  // java_block rotation limits
  if (Format.rotation_limit) {
    const allowed = [-45, -22.5, 0, 22.5, 45];
    const bad = Cube.all.filter((c: any) => {
      const nonZero = c.rotation.filter((r: number) => Math.abs(r) > 1e-5);
      if (!nonZero.length) return false;
      return nonZero.length > 1 || !allowed.includes(nonZero[0]);
    });
    if (bad.length) add('error', 'rotation_limit', `${bad.length} cube(s) violate the format rotation limit (one axis, steps of 22.5°)`, bad.map((c: any) => c.name));
  }

  // Texture density consistency
  for (const tex of Texture.all) {
    const rx = tex.width / (tex.getUVWidth() || 1);
    const ry = tex.height / (tex.getUVHeight() || 1);
    if (Math.abs(rx - Math.round(rx)) > 1e-6 || Math.abs(ry - Math.round(ry)) > 1e-6 || Math.round(rx) !== Math.round(ry)) {
      add('info', 'texture_density', `Texture "${tex.name}" (${tex.width}x${tex.height}) is not an integer multiple of its UV size (${tex.getUVWidth()}x${tex.getUVHeight()}) — pixels may sample unevenly`);
    }
  }

  // Stats
  let faceCount = 0;
  for (const cube of Cube.all) {
    for (const fkey in cube.faces) {
      const f = cube.faces[fkey];
      if (f.texture !== null && f.enabled !== false) faceCount++;
    }
  }
  for (const mesh of Mesh.all) faceCount += Object.keys(mesh.faces).length;
  let maxDepth = 0;
  const depthWalk = (nodes: any[], d: number) => {
    for (const n of nodes) {
      if (n instanceof Group) { maxDepth = Math.max(maxDepth, d); depthWalk(n.children, d + 1); }
    }
  };
  depthWalk(Outliner.root, 1);
  const stats = {
    cubes: Cube.all.length,
    meshes: Mesh.all.length,
    faces: faceCount,
    bones: getAllGroups().length,
    max_bone_depth: maxDepth,
    locators: Project.elements.filter((e: any) => e.type === 'locator').length,
    textures: Texture.all.map((t: any) => `${t.name} ${t.width}x${t.height}`),
    animations: Animation.all.length,
    keyframes: Animation.all.reduce((n: number, a: any) => {
      let c = 0;
      for (const k in a.animators) c += a.animators[k].keyframes.length;
      return n + c;
    }, 0),
  };
  return { findings, stats };
}

register('validate_model', (params) => {
  requireProject();
  const tolerance = params.tolerance ?? 0.01;
  const includeSameBone = params.include_same_bone === true;
  const maxPairs = clampInt(params.max_pairs ?? 40, 1, 500);
  const runChecks = params.checks !== false;
  const runIntersections = params.intersections !== false;

  const out: any = {};
  if (runChecks) {
    const { findings, stats } = staticChecks();
    out.findings = findings;
    out.stats = stats;
    out.ok = !findings.some((f) => f.level === 'error');
  }

  if (runIntersections) {
    if (params.animation) {
      const samples = samplePoses(params, (time) => ({
        time,
        intersections: collectIntersections(tolerance, includeSameBone, maxPairs),
      }));
      out.animation = params.animation;
      out.by_time = samples.map((s: any) => ({
        time: s.time,
        count: s.intersections.filter((h: any) => !h.note).length,
        intersections: s.intersections,
      }));
    } else {
      out.intersections = samplePoses({}, () => collectIntersections(tolerance, includeSameBone, maxPairs))[0];
      out.intersection_count = out.intersections.filter((h: any) => !h.note).length;
    }
    out.intersection_note = 'Overlaps within the same bone are skipped by default (intentional in blocky modeling). penetration is in model units (1/16 block).';
  }
  return out;
});
