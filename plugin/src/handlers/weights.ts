// Vertex weights: how strongly each armature bone moves each mesh vertex.
// auto (Blockbench 5.2's own solver, or distance envelopes), set on a
// selection, smooth across joints, normalize, clear and inspect.
import { register, fail } from '../registry';
import { resolveSelection } from './meshedit';
import {
  requireArmatureSupport, resolveSkinnedMesh, resolveBone, skinnedMeshes, ensureRestPose,
  boneHead, boneTail,
} from '../rig/armature';
import { envelopeWeights, misassignedVertices, normalizeRow, normalizeTable, smoothTable, tableStats, segmentDistance, WeightTable } from '../rig/weightmath';
import { readWeights, writeWeights, worldVertices, refreshSkin } from '../rig/skin';
import { vertexNeighbours } from '../mesh/topology';

const SET_MODES = ['replace', 'mix', 'add', 'subtract'];

function meshesFrom(params: any): any[] {
  const ids: string[] = Array.isArray(params.meshes) ? params.meshes : params.mesh ? [params.mesh] : [];
  if (ids.length) return ids.map(resolveSkinnedMesh);
  const all = skinnedMeshes();
  if (!all.length) fail('No mesh is attached to an armature. Use add_armature {meshes: [...]} first.');
  return all;
}

/** Selected vertex keys: a mesh selection spec, optionally narrowed to those near a bone. */
function selectVertices(mesh: any, params: any): string[] {
  let keys = resolveSelection(mesh, params.select ?? 'all', null, 'select').vertices;
  if (params.near) {
    const bone = resolveBone(params.near.bone, mesh.getArmature());
    ensureRestPose();
    const radius = Number(params.near.distance ?? 2);
    const head = boneHead(bone), tail = boneTail(bone);
    const world = worldVertices(mesh, keys);
    keys = keys.filter((k) => segmentDistance(world.get(k)!, head, tail) <= radius);
    if (!keys.length) fail(`No selected vertex of "${mesh.name}" lies within ${radius} units of bone "${bone.name}".`);
  }
  return keys;
}

/** Run one weight edit over meshes, with the bones (where weights live) in the undo entry. */
function editWeights(meshes: any[], label: string, fn: (mesh: any, bones: any[]) => void) {
  const bones = [...new Set(meshes.flatMap((m) => m.getArmature().getAllBones()))];
  if (!bones.length) fail('The armature has no bones yet. Add them with add_armature {armature, bones: [...]}.');
  Undo.initEdit({ elements: bones });
  try {
    for (const mesh of meshes) fn(mesh, mesh.getArmature().getAllBones());
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  Undo.finishEdit(label, { elements: bones });
  refreshSkin(meshes);
}

function summarize(mesh: any): any {
  const bones = mesh.getArmature().getAllBones();
  const vkeys = Object.keys(mesh.vertices);
  const stats = tableStats(vkeys, readWeights(mesh, bones));
  const name = (id: string) => bones.find((b: any) => b.uuid === id)?.name ?? id;
  const perBone: Record<string, any> = {};
  for (const [id, s] of stats.per_bone) perBone[name(id)] = { vertices: s.vertices, average: Math.round((s.sum / s.vertices) * 1000) / 1000 };
  const world = stats.unweighted.length ? worldVertices(mesh, stats.unweighted.slice(0, 10)) : null;
  return {
    mesh: mesh.name,
    armature: mesh.getArmature().name,
    vertices: stats.vertices,
    per_bone: perBone,
    max_influences: stats.max_influences,
    unweighted: stats.unweighted.length,
    unweighted_sample: world ? [...world].map(([k, p]) => ({ vertex: k, position: p.map((c) => Math.round(c * 100) / 100) })) : undefined,
    not_normalized: stats.not_normalized.length || undefined,
    warning: stats.unweighted.length ? `${stats.unweighted.length} vertices follow no bone — they stay behind when the rig moves. Run vertex_weights "auto" or "set" on them.` : undefined,
  };
}

const segmentsOf = (bones: any[]) => bones.map((b: any) => ({ id: b.uuid, head: boneHead(b), tail: boneTail(b) }));

function envelopeTable(mesh: any, bones: any[], blend: number, maxBones: number, vkeys?: string[]): WeightTable {
  return envelopeWeights(worldVertices(mesh, vkeys), segmentsOf(bones), blend, maxBones);
}

/**
 * Skin meshes to their armature. "blockbench" runs 5.2's Calculate Vertex
 * Weights (edge-loop based, good on limb-like topology) and re-solves from
 * distance envelopes any vertex it leaves unweighted or hands to a bone far
 * away; "envelope" uses distances only.
 */
export function autoWeights(meshes: any[], opts: { method?: string; blend?: number; max_bones?: number }): any[] {
  const method = opts.method ?? 'blockbench';
  if (!['blockbench', 'envelope'].includes(method)) fail('method must be "blockbench" or "envelope".');
  const blend = Math.max(0, Number(opts.blend ?? 2));
  const maxBones = Math.max(1, Math.min(4, Math.round(opts.max_bones ?? 2)));
  ensureRestPose();

  const repaired: Record<string, number> = {};
  if (method === 'blockbench' && BarItems.calculate_vertex_weights) {
    editWeights(meshes, 'MCP: Clear vertex weights', (mesh, bones) => writeWeights(mesh, bones, new Map(), Object.keys(mesh.vertices)));
    unselectAllElements();
    meshes.forEach((m) => m.markAsSelected());
    updateSelection();
    BarItems.calculate_vertex_weights.click();
    // Repair what the solver got wrong: vertices it left out (outside every
    // edge loop) or handed to a bone far away while another runs right past.
    const tolerance = Math.max(2, blend * 2);
    const gaps = meshes.map((m) => {
      const bones = m.getArmature().getAllBones();
      const missing = misassignedVertices(worldVertices(m), readWeights(m, bones), segmentsOf(bones), tolerance);
      return { mesh: m, missing };
    }).filter((g) => g.missing.length);
    if (gaps.length) {
      editWeights(gaps.map((g) => g.mesh), 'MCP: Repair vertex weights', (mesh, bones) => {
        const gap = gaps.find((g) => g.mesh === mesh)!;
        writeWeights(mesh, bones, envelopeTable(mesh, bones, blend, maxBones, gap.missing));
        repaired[mesh.name] = gap.missing.length;
      });
    }
  } else {
    editWeights(meshes, 'MCP: Envelope vertex weights', (mesh, bones) => {
      writeWeights(mesh, bones, envelopeTable(mesh, bones, blend, maxBones));
    });
  }
  return meshes.map((m) => ({ ...summarize(m), method, repaired_by_envelope: repaired[m.name] }));
}

register('weights_auto', (params) => {
  requireArmatureSupport('vertex_weights');
  return { meshes: autoWeights(meshesFrom(params), params) };
});

register('weights_set', (params) => {
  requireArmatureSupport('vertex_weights');
  if (!params.mesh) fail('Pass "mesh" and "bone".');
  const mesh = resolveSkinnedMesh(params.mesh);
  const bone = resolveBone(params.bone, mesh.getArmature());
  const mode = params.mode ?? 'replace';
  if (!SET_MODES.includes(mode)) fail(`mode must be one of ${SET_MODES.join(', ')}.`);
  const weight = Math.max(0, Math.min(1, Number(params.weight ?? 1)));
  const keys = selectVertices(mesh, params);

  editWeights([mesh], 'MCP: Set vertex weights', (m, bones) => {
    const table = readWeights(m, bones);
    for (const vkey of keys) {
      const row = new Map(table.get(vkey) || []);
      const current = row.get(bone.uuid) || 0;
      if (mode === 'replace') {
        table.set(vkey, weight > 0 ? new Map([[bone.uuid, weight]]) : new Map());
        continue;
      }
      if (mode === 'mix') {
        // This bone gets `weight`; the others share what is left in their old ratio.
        row.delete(bone.uuid);
        const rest = normalizeRow(row);
        const mixed = new Map<string, number>();
        for (const [id, w] of rest) mixed.set(id, w * (1 - weight));
        if (weight > 0) mixed.set(bone.uuid, weight);
        table.set(vkey, rest.size ? mixed : new Map([[bone.uuid, 1]]));
        continue;
      }
      row.set(bone.uuid, Math.max(0, mode === 'add' ? current + weight : current - weight));
      table.set(vkey, normalizeRow(row));
    }
    writeWeights(m, bones, table, keys);
  });
  return { set: { mesh: mesh.name, bone: bone.name, mode, weight, vertices: keys.length }, ...summarize(mesh) };
});

register('weights_smooth', (params) => {
  requireArmatureSupport('vertex_weights');
  const meshes = meshesFrom(params);
  const factor = Math.max(0, Math.min(1, Number(params.factor ?? 0.5)));
  const iterations = Math.max(1, Math.min(20, Math.round(params.iterations ?? 2)));
  editWeights(meshes, 'MCP: Smooth vertex weights', (mesh, bones) => {
    const keys = selectVertices(mesh, params);
    const smoothed = smoothTable(readWeights(mesh, bones), vertexNeighbours(mesh), keys, factor, iterations);
    writeWeights(mesh, bones, smoothed, keys);
  });
  return { meshes: meshes.map(summarize), factor, iterations };
});

register('weights_normalize', (params) => {
  requireArmatureSupport('vertex_weights');
  const meshes = meshesFrom(params);
  editWeights(meshes, 'MCP: Normalize vertex weights', (mesh, bones) => {
    writeWeights(mesh, bones, normalizeTable(readWeights(mesh, bones)));
  });
  return { meshes: meshes.map(summarize) };
});

register('weights_clear', (params) => {
  requireArmatureSupport('vertex_weights');
  const meshes = meshesFrom(params);
  editWeights(meshes, 'MCP: Clear vertex weights', (mesh, bones) => {
    const only = params.bone ? resolveBone(params.bone, mesh.getArmature()) : null;
    const keys = selectVertices(mesh, params);
    const table = readWeights(mesh, bones);
    for (const vkey of keys) {
      if (only) table.get(vkey)?.delete(only.uuid);
      else table.set(vkey, new Map());
    }
    writeWeights(mesh, bones, table, keys);
  });
  return { meshes: meshes.map(summarize) };
});

register('weights_inspect', (params) => {
  requireArmatureSupport('vertex_weights');
  return { meshes: meshesFrom(params).map(summarize) };
});
