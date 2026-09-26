// Outliner: groups (bones), cubes, meshes, primitives, planes (fur cards),
// locators, hierarchy edits.
import { register, fail, requireProject } from '../registry';
import { resolveNode, resolveGroup, resolveParent, resolveTexture, vec3, describeNode, refreshElements, hash01 } from '../util';
import { mirrorName, mirrorNodeInPlace, defaultMirrorCenter } from './symmetry';

function applyFaceData(cube: any, facesParam: any) {
  for (const fkey in facesParam) {
    if (!cube.faces[fkey]) fail(`Invalid cube face "${fkey}". Valid faces: north, south, east, west, up, down.`);
    const data = facesParam[fkey];
    const face = cube.faces[fkey];
    if (data.texture !== undefined) {
      face.extend({ texture: data.texture === null || data.texture === false ? data.texture : resolveTexture(data.texture).uuid });
    }
    if (data.uv) face.uv = data.uv.slice();
    if (data.rotation != null) face.rotation = data.rotation;
    if (data.cullface != null) face.cullface = data.cullface;
    if (data.tint != null) face.tint = data.tint;
    if (data.enabled != null) face.enabled = data.enabled;
  }
}

const SHADE_DIRECTIONS = ['', 'north', 'south', 'east', 'west', 'up', 'down'];

/**
 * Java 26.3+ replaced the boolean "shade" with a per-cube light direction
 * (Blockbench 5.2). It only exists on java_block projects targeting 26.3.
 */
function checkShadeOverride(value: string): string {
  if (!Cube.properties?.shade_direction_override) fail('shade_direction_override needs Blockbench 5.2 or newer.');
  if (!SHADE_DIRECTIONS.includes(value)) fail(`shade_direction_override must be one of: ${SHADE_DIRECTIONS.map((d) => d || '"" (none)').join(', ')}.`);
  if (value && !Format.java_cube_shade_direction_override) {
    fail(`shade_direction_override is a Minecraft Java 26.3+ block model feature. ${Format.id === 'java_block' ? 'Raise the project first: set_project_settings {"java_block_version": "26.3"}.' : `The current format is "${Format.id}"; it only applies to java_block.`}`);
  }
  return value;
}

/** IK wiring on a null object: names → uuids, with the same rules Blockbench's menus apply. */
export function applyIkFields(nullObject: any, def: any) {
  const ref = (id: any, label: string, allowed: (n: any) => boolean, kinds: string) => {
    if (id === null || id === '') return '';
    const node = resolveNode(id);
    if (node === nullObject) fail(`${label}: a null object cannot reference itself.`);
    if (!allowed(node)) fail(`${label}: "${node.name}" is a ${node.type}; expected ${kinds}.`);
    return node.uuid;
  };
  const isBone = (n: any) => n instanceof Group || (typeof ArmatureBone !== 'undefined' && n instanceof ArmatureBone);
  if (def.ik_target !== undefined) {
    nullObject.ik_target = ref(def.ik_target, 'ik_target', (n) => isBone(n) || n instanceof Locator, 'a bone (group) or locator — the END of the chain');
  }
  if (def.ik_source !== undefined) {
    nullObject.ik_source = ref(def.ik_source, 'ik_source', isBone, 'a bone (group) — the START of the chain');
  }
  if (def.ik_pole !== undefined) {
    if (!NullObject.properties?.ik_pole) fail('ik_pole needs Blockbench 5.2 or newer.');
    nullObject.ik_pole = ref(def.ik_pole, 'ik_pole', (n) => n instanceof Group || n instanceof Locator || n instanceof NullObject, 'a locator, null object or group');
  }
  if (def.lock_ik_target_rotation !== undefined) nullObject.lock_ik_target_rotation = !!def.lock_ik_target_rotation;
  // Blockbench's solver silently does nothing on a broken chain — say why instead.
  const target = nullObject.ik_target && OutlinerNode.uuids[nullObject.ik_target];
  const source = nullObject.ik_source ? OutlinerNode.uuids[nullObject.ik_source] : nullObject.parent;
  if (target && source && source !== 'root' && !target.isChildOf(source)) {
    fail(`IK chain is broken: target "${target.name}" is not inside ${nullObject.ik_source ? `ik_source "${source.name}"` : `the null object's parent "${source.name}"`}. The chain runs from the source down to the target.`);
  }
}

register('add_groups', (params) => {
  requireProject();
  if (!Array.isArray(params.groups) || !params.groups.length) fail('Pass a "groups" array with at least one group definition.');
  Undo.initEdit({ outliner: true, groups: [] });
  const created: any[] = [];
  try {
    for (const def of params.groups) {
      // Parents created earlier in this same batch are resolvable by name (already in Project.groups).
      const parent = resolveParent(def.parent);
      const group = new Group({
        name: def.name || 'bone',
        origin: vec3(def.origin, Format.centered_grid ? [0, 0, 0] : [8, 8, 8]),
        rotation: vec3(def.rotation, [0, 0, 0]),
      });
      if (def.bedrock_binding) group.bedrock_binding = def.bedrock_binding;
      if (def.color != null) group.color = def.color;
      if (def.visibility === false) group.visibility = false;
      group.addTo(parent === 'root' ? undefined : parent);
      group.isOpen = true;
      if (group.getTypeBehavior('unique_name')) group.createUniqueName();
      group.init();
      created.push(group);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  Canvas.updateAllBones(created);
  Undo.finishEdit('MCP: Add groups', { outliner: true, groups: created });
  return { created: created.map((g) => ({ name: g.name, uuid: g.uuid, parent: g.parent === 'root' ? 'root' : g.parent.name })) };
});

register('add_cubes', (params) => {
  requireProject();
  if (!Array.isArray(params.cubes) || !params.cubes.length) fail('Pass a "cubes" array with at least one cube definition ({name, from, to, ...}).');
  const defaultTexture = params.texture ? resolveTexture(params.texture) : (Texture.getDefault() || undefined);
  Undo.initEdit({ outliner: true, elements: [], selection: true });
  const created: any[] = [];
  try {
    for (const def of params.cubes) {
      const from = vec3(def.from);
      const to = vec3(def.to);
      if (!from || !to) fail(`Cube "${def.name || '?'}" needs "from" and "to" [x,y,z] coordinates.`);
      const parent = def.parent != null ? resolveParent(def.parent) : 'root';
      const data: any = {
        name: def.name || 'cube',
        from, to,
        origin: vec3(def.origin, (parent !== 'root' && Format.bone_rig) ? parent.origin.slice() : [0, 0, 0]),
        rotation: vec3(def.rotation, [0, 0, 0]),
        inflate: def.inflate || 0,
        autouv: def.autouv ?? 0,
        mirror_uv: def.mirror_uv === true,
        visibility: def.visibility !== false,
        shade: def.shade !== false,
      };
      if (def.box_uv != null) data.box_uv = def.box_uv;
      if (def.uv_offset) data.uv_offset = def.uv_offset.slice();
      if (def.color != null) data.color = def.color;
      if (def.rescale != null) data.rescale = def.rescale;
      if (def.shade_direction_override != null) data.shade_direction_override = checkShadeOverride(def.shade_direction_override);
      const cube = new Cube(data).init();
      if (parent !== 'root') cube.addTo(parent);
      const tex = def.texture !== undefined
        ? (def.texture === null || def.texture === false ? undefined : resolveTexture(def.texture))
        : defaultTexture;
      if (tex) cube.applyTexture(tex, true);
      if (!cube.box_uv && !def.faces) cube.mapAutoUV();
      if (def.faces) applyFaceData(cube, def.faces);
      created.push(cube);
      if (def.mirror === true) {
        // Create the X-mirrored twin. It parents into the mirrored-name group
        // when one exists (leg_left → leg_right), else stays with its sibling.
        const twin = cube.duplicate();
        mirrorNodeInPlace(twin, 0, defaultMirrorCenter());
        const twinName = mirrorName(cube.name);
        twin.name = twinName !== cube.name ? twinName : `${cube.name}_m`;
        twin.createUniqueName?.();
        if (parent !== 'root') {
          const mirrorParentName = mirrorName(parent.name);
          if (mirrorParentName !== parent.name) {
            const mirrorParent = Project.groups.find((g: any) => g.name === mirrorParentName);
            if (mirrorParent) {
              twin.addTo(mirrorParent);
              if (!def.origin) twin.origin.replace(mirrorParent.origin.slice());
            }
          }
        }
        created.push(twin);
      }
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  refreshElements(created);
  Undo.finishEdit('MCP: Add cubes', { outliner: true, elements: created, selection: true });
  return { created: created.map((c) => ({ name: c.name, uuid: c.uuid, parent: c.parent === 'root' ? 'root' : c.parent.name })) };
});

register('add_meshes', (params) => {
  requireProject();
  if (!Format.meshes) fail(`The current format "${Format.id}" does not support meshes — only cubes. Use the "free" (Generic Model) format for meshes, or build the shape from cubes.`);
  if (!Array.isArray(params.meshes) || !params.meshes.length) fail('Pass a "meshes" array with at least one mesh definition.');
  Undo.initEdit({ outliner: true, elements: [], selection: true });
  const created: any[] = [];
  try {
    for (const def of params.meshes) {
      if (!def.vertices || typeof def.vertices !== 'object' || !Object.keys(def.vertices).length) {
        fail(`Mesh "${def.name || '?'}" needs a "vertices" object: {"a": [x,y,z], "b": [...], ...}`);
      }
      const mesh = new Mesh({
        name: def.name || 'mesh',
        vertices: {},
        origin: vec3(def.position ?? def.origin, [0, 0, 0]),
        rotation: vec3(def.rotation, [0, 0, 0]),
      });
      for (const vkey in def.vertices) {
        mesh.vertices[vkey] = vec3(def.vertices[vkey]);
      }
      const tex = def.texture ? resolveTexture(def.texture) : (Texture.getDefault() || undefined);
      const faceKeys: string[] = [];
      for (const faceDef of def.faces || []) {
        const verts: string[] = faceDef.vertices;
        if (!Array.isArray(verts) || verts.length < 3 || verts.length > 4) {
          fail(`Each mesh face needs 3 or 4 vertex keys, got ${JSON.stringify(verts)}`);
        }
        for (const v of verts) {
          if (!mesh.vertices[v]) fail(`Face references unknown vertex key "${v}" in mesh "${def.name || '?'}".`);
        }
        const face = new MeshFace(mesh, { vertices: verts, uv: faceDef.uv || {}, texture: tex?.uuid });
        faceKeys.push(...mesh.addFaces(face));
      }
      if (def.parent != null && def.parent !== 'root') mesh.addTo(resolveParent(def.parent));
      mesh.init();
      if (!def.faces?.some((f: any) => f.uv)) {
        try { UVEditor.setAutoSize(null, true, Object.keys(mesh.faces)); } catch {}
      }
      created.push(mesh);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  refreshElements(created);
  Undo.finishEdit('MCP: Add meshes', { outliner: true, elements: created, selection: true });
  return { created: created.map((m) => ({ name: m.name, uuid: m.uuid, vertices: Object.keys(m.vertices).length, faces: Object.keys(m.faces).length })) };
});

const HEDRONS = ['icosphere', 'octahedron', 'dodecahedron'];

/** Generate primitive mesh geometry (sphere, cylinder, cone, torus, plane, pyramid, 5.2 polyhedra). */
register('add_mesh_primitive', (params) => {
  requireProject();
  if (!Format.meshes) fail(`The current format "${Format.id}" does not support meshes. Use the "free" format, or approximate the shape with cubes.`);
  const shape = params.shape;
  const diameter = params.diameter ?? 16;
  const r = diameter / 2;
  const height = params.height ?? 16;
  const sides = Math.max(3, Math.min(64, Math.round(params.sides ?? 16)));
  const name = params.name || shape;

  const vertices: Record<string, [number, number, number]> = {};
  const faces: { vertices: string[] }[] = [];
  let vi = 0;
  const V = (x: number, y: number, z: number): string => {
    const key = `v${vi++}`;
    vertices[key] = [x, y, z];
    return key;
  };
  const TAU = Math.PI * 2;

  if (shape === 'plane') {
    const a = V(-r, 0, -r), b = V(r, 0, -r), c = V(r, 0, r), d = V(-r, 0, r);
    faces.push({ vertices: [a, b, c, d] });
  } else if (shape === 'pyramid') {
    const a = V(-r, 0, -r), b = V(r, 0, -r), c = V(r, 0, r), d = V(-r, 0, r), top = V(0, height, 0);
    faces.push({ vertices: [d, c, b, a] });
    faces.push({ vertices: [a, b, top] }, { vertices: [b, c, top] }, { vertices: [c, d, top] }, { vertices: [d, a, top] });
  } else if (shape === 'cylinder' || shape === 'cone') {
    const topR = shape === 'cone' ? 0 : r;
    const bottom: string[] = [], top: string[] = [];
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * TAU;
      bottom.push(V(Math.cos(angle) * r, 0, Math.sin(angle) * r));
      if (shape === 'cylinder') top.push(V(Math.cos(angle) * topR, height, Math.sin(angle) * topR));
    }
    const apex = shape === 'cone' ? V(0, height, 0) : null;
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (shape === 'cylinder') faces.push({ vertices: [bottom[i], bottom[j], top[j], top[i]] });
      else faces.push({ vertices: [bottom[i], bottom[j], apex!] });
    }
    faces.push({ vertices: [...bottom].reverse() });
    if (shape === 'cylinder') faces.push({ vertices: top });
  } else if (shape === 'sphere') {
    const rings = Math.max(3, Math.round(sides / 2));
    const grid: string[][] = [];
    for (let ring = 1; ring < rings; ring++) {
      const phi = (ring / rings) * Math.PI;
      const y = Math.cos(phi) * r;
      const ringR = Math.sin(phi) * r;
      const row: string[] = [];
      for (let i = 0; i < sides; i++) {
        const angle = (i / sides) * TAU;
        row.push(V(Math.cos(angle) * ringR, y + r, Math.sin(angle) * ringR));
      }
      grid.push(row);
    }
    const top = V(0, diameter, 0), bottom = V(0, 0, 0);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      faces.push({ vertices: [top, grid[0][j], grid[0][i]] });
      for (let ring = 0; ring < grid.length - 1; ring++) {
        faces.push({ vertices: [grid[ring][i], grid[ring][j], grid[ring + 1][j], grid[ring + 1][i]] });
      }
      faces.push({ vertices: [grid[grid.length - 1][i], grid[grid.length - 1][j], bottom] });
    }
  } else if (shape === 'torus') {
    const minor = (params.minor_diameter ?? diameter / 4) / 2;
    const minorSides = Math.max(3, Math.round(params.minor_sides ?? Math.max(6, sides / 2)));
    const grid: string[][] = [];
    for (let i = 0; i < sides; i++) {
      const u = (i / sides) * TAU;
      const row: string[] = [];
      for (let j = 0; j < minorSides; j++) {
        const v = (j / minorSides) * TAU;
        const x = (r + minor * Math.cos(v)) * Math.cos(u);
        const z = (r + minor * Math.cos(v)) * Math.sin(u);
        const y = minor * Math.sin(v) + minor;
        row.push(V(x, y, z));
      }
      grid.push(row);
    }
    for (let i = 0; i < sides; i++) {
      const i2 = (i + 1) % sides;
      for (let j = 0; j < minorSides; j++) {
        const j2 = (j + 1) % minorSides;
        faces.push({ vertices: [grid[i][j], grid[i2][j], grid[i2][j2], grid[i][j2]] });
      }
    }
  } else if (HEDRONS.includes(shape)) {
    // Blockbench 5.2's polyhedra, built from THREE's generators the same way
    // its Add Primitive dialog does — but with a true radius (the dialog passes
    // the diameter as the radius) and resting on the ground like our sphere.
    const maxDetail = 4;
    const detail = Math.max(0, Math.min(maxDetail, Math.round(params.detail ?? (shape === 'icosphere' ? 1 : 0))));
    const Geometry = shape === 'octahedron' ? THREE.OctahedronGeometry
      : shape === 'dodecahedron' ? THREE.DodecahedronGeometry
        : THREE.IcosahedronGeometry;
    const geometry = new Geometry(r, detail);
    const pos = geometry.attributes.position;
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) minY = Math.min(minY, pos.getY(i));
    // Non-indexed triangle soup → shared vertices, so the mesh stays connected.
    const byKey = new Map<string, string>();
    const vertexAt = (i: number): string => {
      const x = pos.getX(i), y = pos.getY(i) - minY, z = pos.getZ(i);
      const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
      let vkey = byKey.get(key);
      if (!vkey) { vkey = V(x, y, z); byKey.set(key, vkey); }
      return vkey;
    };
    for (let i = 0; i + 2 < pos.count; i += 3) {
      const tri = [vertexAt(i), vertexAt(i + 1), vertexAt(i + 2)];
      if (new Set(tri).size === 3) faces.push({ vertices: tri });
    }
    geometry.dispose?.();
  } else {
    fail(`Unknown primitive shape "${shape}". Valid: plane, pyramid, cylinder, cone, sphere, torus, icosphere, octahedron, dodecahedron.`);
  }

  const result = (getHandlerResult('add_meshes', {
    meshes: [{
      name,
      parent: params.parent,
      position: params.position,
      rotation: params.rotation,
      vertices,
      faces,
      texture: params.texture,
    }],
  }));
  return result;
});

// small internal helper to reuse handlers
import { getHandler } from '../registry';
function getHandlerResult(command: string, params: any) {
  const handler = getHandler(command);
  if (!handler) fail(`Internal error: missing handler ${command}`);
  return handler!(params);
}

register('list_outline', (params) => {
  requireProject();
  const includeElements = params?.include_elements !== false;
  const maxDepth = params?.max_depth ?? 32;
  const walk = (nodes: any[], depth: number): any[] => {
    const out: any[] = [];
    for (const node of nodes) {
      if (node instanceof Group) {
        const entry: any = describeNode(node);
        entry.children = depth < maxDepth ? walk(node.children, depth + 1) : `[${node.children.length} children]`;
        out.push(entry);
      } else if (includeElements) {
        out.push(describeNode(node));
      }
    }
    return out;
  };
  return {
    format: Format.id,
    texture_size: [Project.texture_width, Project.texture_height],
    root: walk(Outliner.root, 1),
  };
});

register('get_element', (params) => {
  requireProject();
  return describeNode(resolveNode(params.id), true);
});

register('update_elements', (params) => {
  requireProject();
  if (!Array.isArray(params.elements) || !params.elements.length) fail('Pass an "elements" array of {id, ...changes}.');
  const nodes = params.elements.map((def: any) => resolveNode(def.id));
  const elements = nodes.filter((n: any) => n instanceof OutlinerElement);
  const groups = nodes.filter((n: any) => n instanceof Group);
  Undo.initEdit({ elements, groups, outliner: true, selection: true });
  const updated: string[] = [];
  try {
    params.elements.forEach((def: any, i: number) => {
      const node = nodes[i];
      const data: any = {};
      for (const key of ['name', 'origin', 'rotation', 'from', 'to', 'inflate', 'visibility', 'autouv', 'shade', 'mirror_uv', 'uv_offset', 'color', 'box_uv', 'rescale', 'bedrock_binding']) {
        if (def[key] !== undefined) data[key] = def[key];
      }
      if (def.shade_direction_override !== undefined) {
        if (!(node instanceof Cube)) fail(`shade_direction_override applies to cubes; "${node.name}" is a ${node.type}.`);
        data.shade_direction_override = checkShadeOverride(def.shade_direction_override ?? '');
      }
      if (def.function !== undefined) {
        if (typeof BoundingBox === 'undefined' || !(node instanceof BoundingBox)) fail(`"function" applies to bounding boxes; "${node.name}" is a ${node.type}.`);
        data.function = def.function.slice();
      }
      if (Object.keys(data).length) node.extend(data);
      if (def.position !== undefined && node.position) node.position.replace(def.position);
      if (['ik_target', 'ik_source', 'ik_pole', 'lock_ik_target_rotation'].some((k) => def[k] !== undefined)) {
        if (node.type !== 'null_object') fail(`IK settings (ik_target/ik_source/ik_pole/lock_ik_target_rotation) belong to null objects; "${node.name}" is a ${node.type}. Create one with add_ik_controllers.`);
        applyIkFields(node, def);
      }
      if (def.faces && node instanceof Cube) applyFaceData(node, def.faces);
      if (def.vertices && node instanceof Mesh) {
        for (const vkey in def.vertices) {
          if (def.vertices[vkey] === null) delete node.vertices[vkey];
          else node.vertices[vkey] = vec3(def.vertices[vkey]);
        }
      }
      if (def.parent !== undefined) {
        const parent = resolveParent(def.parent);
        node.addTo(parent === 'root' ? 'root' : parent, def.parent_index ?? -1);
      }
      if (def.name !== undefined && node.getTypeBehavior?.('unique_name')) node.createUniqueName();
      updated.push(node.uuid);
    });
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  refreshElements(nodes);
  Canvas.updateAllUVs();
  Undo.finishEdit('MCP: Update elements', { elements, groups, outliner: true, selection: true });
  return { updated };
});

register('delete_elements', (params) => {
  requireProject();
  if (!Array.isArray(params.ids) || !params.ids.length) fail('Pass an "ids" array of uuids or names to delete.');
  const nodes = params.ids.map((id: string) => resolveNode(id));
  const elements: any[] = [];
  const groups: any[] = [];
  for (const node of nodes) {
    if (node instanceof Group) {
      groups.push(node);
      node.forEachChild((child: any) => {
        (child.type === 'group' ? groups : elements).push(child);
      });
    } else {
      elements.push(node);
    }
  }
  const animations = Animation.all.filter((a: any) => groups.some((g: any) => a.animators?.[g.uuid]));
  Undo.initEdit({ elements, groups, outliner: true, selection: true, animations });
  for (const node of nodes) {
    if (OutlinerNode.uuids[node.uuid]) node.remove(false);
  }
  updateSelection();
  Undo.finishEdit('MCP: Delete elements', { elements: [], groups: [], outliner: true, selection: true, animations });
  return { deleted: nodes.map((n: any) => n.name) };
});

register('duplicate_elements', (params) => {
  requireProject();
  if (!Array.isArray(params.ids) || !params.ids.length) fail('Pass an "ids" array of uuids or names to duplicate.');
  const offset = params.offset ? vec3(params.offset) : null;
  Undo.initEdit({ outliner: true, elements: [], selection: true });
  const clones: any[] = [];
  try {
    for (const id of params.ids) {
      const node = resolveNode(id);
      const clone = node.duplicate();
      if (params.name && params.ids.length === 1) { clone.name = params.name; clone.createUniqueName?.(); }
      if (offset) {
        const moveNode = (n: any) => {
          if (n instanceof Cube) {
            n.from.forEach((_: number, i: number) => { n.from[i] += offset[i]; n.to[i] += offset[i]; n.origin[i] += offset[i]; });
          } else if (n.origin) {
            n.origin.forEach((_: number, i: number) => { n.origin[i] += offset[i]; });
          } else if (n.position) {
            n.position.forEach((_: number, i: number) => { n.position[i] += offset[i]; });
          }
          if (n.children) n.children.forEach(moveNode);
        };
        moveNode(clone);
      }
      clones.push(clone);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  const flat: any[] = [];
  const collect = (n: any) => { flat.push(n); n.children?.forEach(collect); };
  clones.forEach(collect);
  refreshElements(flat);
  Undo.finishEdit('MCP: Duplicate elements', { outliner: true, elements: flat.filter((n) => n instanceof OutlinerElement), selection: true });
  return { created: clones.map((c) => ({ name: c.name, uuid: c.uuid })) };
});

// ─────────────────────── planes (fur/foliage cards) ───────────────────────

const PLANE_SPANS: Record<string, { widthAxis: number; heightAxis: number; flatAxis: number; faces: [string, string] }> = {
  north: { widthAxis: 0, heightAxis: 1, flatAxis: 2, faces: ['north', 'south'] },
  south: { widthAxis: 0, heightAxis: 1, flatAxis: 2, faces: ['south', 'north'] },
  east: { widthAxis: 2, heightAxis: 1, flatAxis: 0, faces: ['east', 'west'] },
  west: { widthAxis: 2, heightAxis: 1, flatAxis: 0, faces: ['west', 'east'] },
  up: { widthAxis: 0, heightAxis: 2, flatAxis: 1, faces: ['up', 'down'] },
  down: { widthAxis: 0, heightAxis: 2, flatAxis: 1, faces: ['down', 'up'] },
};

register('add_planes', (params) => {
  requireProject();
  const defs: any[] = Array.isArray(params.planes) ? params.planes.slice() : [];

  // Expand strips (rows of overlapping tufts along a base line) into planes.
  for (const strip of params.strips || []) {
    const from = vec3(strip.from);
    const to = vec3(strip.to);
    if (!from || !to) fail('Each strip needs "from" and "to" [x,y,z] — the base line the tufts grow from.');
    const count = Math.max(1, Math.min(64, Math.round(strip.count ?? 6)));
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const horizLen = Math.hypot(dx, dz);
    const yaw = horizLen > 1e-6 ? -Math.atan2(dz, dx) * 180 / Math.PI : 0;
    const segLen = (horizLen || Math.abs(dy) || 1) / count;
    const width = strip.width ?? segLen * (1 + (strip.overlap ?? 0.3));
    const height = strip.height ?? 4;
    const tilt = strip.tilt ?? 0;
    const jitter = Math.max(0, Math.min(1, strip.jitter ?? 0.25));
    const seed = strip.seed ?? 1;
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const base = [from[0] + dx * t, from[1] + dy * t, from[2] + dz * t];
      const h = height * (1 + (hash01(i, 1, seed) * 2 - 1) * jitter * 0.5);
      const tiltSign = strip.alternate_tilt ? (i % 2 === 0 ? 1 : -1) : 1;
      const tiltI = tilt * tiltSign + (hash01(i, 2, seed) * 2 - 1) * jitter * 12;
      defs.push({
        name: `${strip.name_prefix || 'fur'}_${i}`,
        parent: strip.parent,
        at: base,
        width,
        height: h,
        // Always a north-frame card: yaw aligns the width to the from→to
        // line for ANY direction, and tilt (X, innermost in ZYX) then rotates
        // around the card's true base edge. A per-facing frame would break
        // both for east/west strips.
        facing: 'north',
        rotation: [tiltI, yaw, 0],
        texture: strip.texture,
        uv: strip.uv,
        double_sided: strip.double_sided,
      });
    }
  }

  if (!defs.length) fail('Pass "planes" and/or "strips". A plane: {at: [x,y,z] (base center), width, height, facing, rotation?, texture?}.');
  if (defs.length > 256) fail(`Too many planes in one call (${defs.length} > 256). Split into batches.`);

  const defaultTexture = params.texture ? resolveTexture(params.texture) : (Texture.getDefault() || undefined);
  Undo.initEdit({ outliner: true, elements: [], selection: true });
  const created: any[] = [];
  try {
    for (const def of defs) {
      const at = vec3(def.at);
      if (!at) fail(`Plane "${def.name || '?'}" needs "at" [x,y,z] — the center of its base edge.`);
      const spec = PLANE_SPANS[def.facing || 'north'];
      if (!spec) fail(`Invalid facing "${def.facing}". Valid: north, south, east, west, up, down.`);
      const w = Math.abs(def.width ?? 4);
      const h = Math.abs(def.height ?? 4);
      const from: [number, number, number] = [at[0], at[1], at[2]];
      const to: [number, number, number] = [at[0], at[1], at[2]];
      from[spec.widthAxis] -= w / 2;
      to[spec.widthAxis] += w / 2;
      to[spec.heightAxis] += h;
      const parent = def.parent != null ? resolveParent(def.parent) : 'root';
      const cube = new Cube({
        name: def.name || 'plane',
        from, to,
        origin: vec3(def.origin, at), // pivot at the base → tilting rotates around the attachment edge
        rotation: vec3(def.rotation, [0, 0, 0]),
        autouv: 0,
        shade: def.shade !== false,
        visibility: true,
      }).init();
      if (parent !== 'root') cube.addTo(parent);
      const tex = def.texture !== undefined
        ? (def.texture === null ? undefined : resolveTexture(def.texture))
        : defaultTexture;
      if (tex) cube.applyTexture(tex, true);
      const [front, back] = spec.faces;
      for (const fkey in cube.faces) {
        if (fkey === front) continue;
        if (fkey === back && def.double_sided !== false) continue;
        cube.faces[fkey].extend({ texture: null });
      }
      if (def.uv) {
        cube.faces[front].uv = def.uv.slice();
        if (def.double_sided !== false) {
          // Back face mirrored horizontally so the texture reads correctly from both sides
          cube.faces[back].uv = [def.uv[2], def.uv[1], def.uv[0], def.uv[3]];
        }
      }
      created.push(cube);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  refreshElements(created);
  Undo.finishEdit('MCP: Add planes', { outliner: true, elements: created, selection: true });
  return {
    created: created.map((c) => ({ name: c.name, uuid: c.uuid, parent: c.parent === 'root' ? 'root' : c.parent.name })),
    note: 'Planes are zero-thickness cubes with only their two large faces active. Paint fur silhouettes with paint_texture jagged_edge (mode "erase") on their UVs.',
  };
});

register('add_locators', (params) => {
  requireProject();
  if (!Format.locators) fail(`Format "${Format.id}" does not support locators. They exist in bedrock-style formats (attachment points for particles/items/leads).`);
  if (!Array.isArray(params.locators) || !params.locators.length) fail('Pass "locators": [{name, position: [x,y,z], parent?, rotation?}].');
  Undo.initEdit({ outliner: true, elements: [], selection: true });
  const created: any[] = [];
  try {
    for (const def of params.locators) {
      // addTo BEFORE init: Locator.init() auto-parents to the currently
      // selected group when its parent is not a Group (core usage is
      // new Locator().addTo(group).init()).
      const parent = resolveParent(def.parent);
      const locator = new Locator({
        name: def.name || 'locator',
        position: vec3(def.position, [0, 0, 0]),
        rotation: vec3(def.rotation, [0, 0, 0]),
      });
      if (parent !== 'root') locator.addTo(parent);
      locator.init();
      if (parent === 'root' && locator.parent !== 'root') locator.addTo('root');
      created.push(locator);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  refreshElements(created);
  Undo.finishEdit('MCP: Add locators', { outliner: true, elements: created, selection: true });
  return { created: created.map((l) => ({ name: l.name, uuid: l.uuid, parent: l.parent === 'root' ? 'root' : l.parent.name })) };
});

register('add_bounding_boxes', (params) => {
  requireProject();
  if (typeof BoundingBox === 'undefined') fail('Bounding boxes need Blockbench 5.1 or newer.');
  if (!Format.bounding_boxes) {
    fail(`Format "${Format.id}" has no bounding boxes. They exist in the bedrock formats and (since Blockbench 5.2) the generic "free" format.`);
  }
  if (!Array.isArray(params.boxes) || !params.boxes.length) fail('Pass "boxes": [{name, from: [x,y,z], to: [x,y,z], function?: ["collision"|"hitbox"], parent?}].');
  Undo.initEdit({ outliner: true, elements: [], selection: true });
  const created: any[] = [];
  try {
    for (const def of params.boxes) {
      const from = vec3(def.from), to = vec3(def.to);
      if (!from || !to) fail(`Bounding box "${def.name || '?'}" needs "from" and "to".`);
      const fn = def.function ?? [];
      for (const f of fn) if (!['collision', 'hitbox'].includes(f)) fail(`Bounding box function "${f}" is invalid. Valid: collision, hitbox.`);
      const parent = resolveParent(def.parent);
      const box = new BoundingBox({ name: def.name || 'bounding_box', from, to, function: fn.slice() });
      if (def.color != null) box.color = def.color;
      if (parent !== 'root') box.addTo(parent);
      box.init();
      created.push(box);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  refreshElements(created, { transform: true, geometry: true });
  Undo.finishEdit('MCP: Add bounding boxes', { outliner: true, elements: created, selection: true });
  return {
    created: created.map((b) => ({ name: b.name, uuid: b.uuid, from: b.from.slice(), to: b.to.slice(), function: b.function?.slice() })),
    note: 'Bounding boxes are wireframe helpers (collision/hitbox) — they are hidden in screenshots and exported only by formats that support them.',
  };
});

register('select_elements', (params) => {
  requireProject();
  if (params.mode === 'none') {
    unselectAllElements();
    updateSelection();
    return { selected: 0 };
  }
  if (params.mode === 'all') {
    unselectAllElements();
    Project.elements.forEach((el: any) => el.markAsSelected());
    updateSelection();
    return { selected: Project.elements.length };
  }
  if (!Array.isArray(params.ids) || !params.ids.length) fail('Pass "ids" array, or mode: "all" | "none".');
  unselectAllElements();
  let count = 0;
  for (const id of params.ids) {
    const node = resolveNode(id);
    if (node instanceof Group) { node.multiSelect(); count++; }
    else { node.markAsSelected(); count++; }
  }
  updateSelection();
  return { selected: count };
});
