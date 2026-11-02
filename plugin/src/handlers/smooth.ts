// Smooth meshes: the BlockSmooth plugin's modifier stack (subdivision, smooth
// by angle), edge creases and sharp marks, apply; plus Blockbench's own
// flat / smooth shading switch, which needs no plugin.
import { register, fail, requireProject } from '../registry';
import { resolveNode } from '../util';
import { callBlockSmooth } from '../blocksmooth';

function resolveMesh(id: string): any {
  requireProject();
  const node = resolveNode(id);
  if (!(node instanceof Mesh)) {
    fail(`"${node.name}" is a ${node.type}, not a mesh. Smoothing works on meshes — convert a cube with run_action "convert_to_mesh" or build one with add_mesh_primitive / add_loft.`);
  }
  return node;
}

function meshesOf(params: any): any[] {
  const ids: string[] = Array.isArray(params.meshes) ? params.meshes : params.mesh ? [params.mesh] : [];
  if (!ids.length) fail('Pass "mesh" (name/uuid) or "meshes" (several).');
  return [...new Set(ids.map(resolveMesh))];
}

/** One undo step around several API calls (each called with {undo: false}). */
function withUndo<T>(meshes: any[], label: string, fn: () => T): T {
  Undo.initEdit({ elements: meshes });
  let result: T;
  try {
    result = fn();
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  Undo.finishEdit(label);
  return result;
}

const describe = (mesh: any) => callBlockSmooth((api) => api.describe(mesh));

/** Modifier fields given in params, untouched otherwise (BlockSmooth validates and clamps). */
function modifierPatch(params: any): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of ['levels', 'export_levels', 'angle', 'viewport', 'export']) {
    if (params[key] !== undefined) patch[key] = params[key];
  }
  return patch;
}

/** Exactly one edge source: explicit pairs, an angle, or the edit-mode selection. */
function edgeSpec(params: any): unknown {
  const given = ['edges', 'angle', 'selected'].filter((k) => params[k] !== undefined && params[k] !== false);
  if (given.length !== 1) {
    fail('Pick the edges with exactly one of: "edges" [[vertexA, vertexB], ...] (vertex keys from get_element), "angle" (every edge whose faces meet at more than this many degrees) or "selected": true (the edit-mode selection).');
  }
  if (params.edges !== undefined) return params.edges;
  if (params.angle !== undefined) return { angle: Number(params.angle) };
  return 'selected';
}

register('smooth_describe', (params) => {
  if (params.mesh || params.meshes) return { meshes: meshesOf(params).map(describe) };
  requireProject();
  return { meshes: Mesh.all.map(describe) };
});

register('smooth_add', (params) => {
  const meshes = meshesOf(params);
  const patch = modifierPatch(params);
  const added = withUndo(meshes, 'Add BlockSmooth modifier', () => meshes.map((mesh) => callBlockSmooth((api) =>
    api.addModifier(mesh, params.type, patch, { undo: false, smoothShading: params.smooth_shading !== false }))));
  return { added, meshes: meshes.map(describe) };
});

register('smooth_update', (params) => {
  const mesh = resolveMesh(params.mesh);
  if (params.modifier === undefined) fail('Pass "modifier": its id or index from smooth_mesh "describe".');
  const updated = callBlockSmooth((api) => api.updateModifier(mesh, params.modifier, modifierPatch(params)));
  return { updated, mesh: describe(mesh) };
});

register('smooth_remove', (params) => {
  const mesh = resolveMesh(params.mesh);
  if (params.modifier === undefined) fail('Pass "modifier": its id or index from smooth_mesh "describe".');
  callBlockSmooth((api) => api.removeModifier(mesh, params.modifier));
  return { mesh: describe(mesh) };
});

register('smooth_move', (params) => {
  const mesh = resolveMesh(params.mesh);
  if (params.modifier === undefined || params.to === undefined) fail('Pass "modifier" (id or index) and "to" (new index, 0 = first).');
  callBlockSmooth((api) => api.moveModifier(mesh, params.modifier, Number(params.to)));
  return { mesh: describe(mesh) };
});

register('smooth_crease', (params) => {
  const mesh = resolveMesh(params.mesh);
  const value = params.value === undefined ? 1 : Number(params.value);
  const spec = edgeSpec(params);
  const edges = callBlockSmooth((api) => api.setCrease(mesh, spec, value));
  return { edges, crease: Math.max(0, Math.min(1, value)), mesh: describe(mesh) };
});

register('smooth_sharp', (params) => {
  const mesh = resolveMesh(params.mesh);
  const sharp = params.sharp !== false;
  const spec = edgeSpec(params);
  const edges = callBlockSmooth((api) => api.setSharp(mesh, spec, sharp));
  return { edges, sharp, mesh: describe(mesh) };
});

register('smooth_apply', (params) => {
  const meshes = meshesOf(params);
  const results = meshes.map((mesh) => ({ mesh: mesh.name, ...callBlockSmooth((api) => api.apply(mesh)) }));
  const nothing = results.filter((r) => !r.applied).map((r) => r.mesh);
  return {
    results,
    note: nothing.length ? `Nothing to apply on ${nothing.join(', ')}: no subdivision modifier is shown in the viewport.` : undefined,
  };
});

// Blockbench's own per-mesh shading; works without BlockSmooth.
register('mesh_shading', (params) => {
  if (params.shading !== 'flat' && params.shading !== 'smooth') fail('"shading" must be "flat" or "smooth".');
  const meshes = meshesOf(params);
  withUndo(meshes, 'Mesh shading', () => { for (const mesh of meshes) mesh.shading = params.shading; });
  Canvas.updateView({ elements: meshes, element_aspects: { geometry: true } });
  return { meshes: meshes.map((m: any) => m.name), shading: params.shading };
});
