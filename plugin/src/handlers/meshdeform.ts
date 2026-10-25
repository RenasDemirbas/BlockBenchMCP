// transform_mesh: deform mesh vertices (taper, bend, twist, scale, rotate,
// move, smooth, jitter) — the shaping half of box modeling. An optional
// "falloff" (proportional editing) lets each deformer fade out over the
// vertices around the selection instead of stopping at its edge.
import { register, fail, requireProject } from '../registry';
import { resolveNode, refreshElements } from '../util';
import { P3 } from '../surface';
import { resolveSelection, relax } from './meshedit';
import { deformFrame, deformPoint } from '../mesh/deformers';
import { falloffWeights, FalloffSpec, FALLOFF_CURVES } from '../mesh/falloff';
import { vertexNeighbours } from '../mesh/topology';

function falloffSpec(raw: any): FalloffSpec | null {
  if (raw == null) return null;
  const radius = Number(raw.radius);
  if (!(radius > 0)) fail('falloff.radius must be a positive distance in model units.');
  if (raw.curve && !FALLOFF_CURVES.includes(raw.curve)) fail(`falloff.curve must be one of ${FALLOFF_CURVES.join(', ')}.`);
  if (raw.distance && !['linear', 'connected'].includes(raw.distance)) fail('falloff.distance must be "linear" or "connected".');
  return { radius, curve: raw.curve, distance: raw.distance };
}

register('transform_mesh', (params) => {
  requireProject();
  const ids: string[] = Array.isArray(params.meshes) ? params.meshes : [params.mesh];
  if (!ids.length || ids[0] == null) fail('Pass "mesh" (or "meshes": [...]).');
  const meshes = ids.map((id) => {
    const n = resolveNode(id);
    if (!(n instanceof Mesh)) fail(`"${id}" is a ${n.type}, not a mesh.`);
    return n;
  });
  const ops: any[] = Array.isArray(params.ops) ? params.ops : [];
  if (!ops.length) fail('Pass "ops": [{type: taper|bend|twist|scale|rotate|move|smooth|jitter, ...}].');
  const falloff = falloffSpec(params.falloff);

  Undo.initEdit({ elements: meshes });
  const report: any[] = [];
  try {
    for (const mesh of meshes) {
      const sel = resolveSelection(mesh, params.select, null, 'select');
      const keys = sel.vertices.length ? sel.vertices : Object.keys(mesh.vertices);
      // Weights come from the rest shape, like Blockbench's own proportional editing.
      const soft = falloff ? falloffWeights(mesh.vertices, vertexNeighbours(mesh), keys, falloff) : new Map<string, number>();
      const softKeys = [...soft.keys()];
      const get = (k: string) => mesh.vertices[k] as P3;
      ops.forEach((op, i) => {
        const label = `ops[${i}] (${op.type})`;
        if (op.type === 'smooth') {
          relax(mesh, keys, Math.max(0, Math.min(1, op.factor ?? 0.5)), Math.max(1, Math.min(20, Math.round(op.iterations ?? 1))));
          return;
        }
        const frame = deformFrame(op, keys.map(get), label);
        const moved = new Map<string, P3>();
        keys.forEach((k, n) => moved.set(k, deformPoint(op, get(k), frame, n, label)));
        softKeys.forEach((k, n) => {
          const p = get(k), q = deformPoint(op, p, frame, keys.length + n, label), w = soft.get(k)!;
          moved.set(k, [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w, p[2] + (q[2] - p[2]) * w]);
        });
        for (const [k, p] of moved) mesh.vertices[k] = p;
      });
      const entry: any = { mesh: mesh.name, vertices_moved: keys.length };
      if (falloff) {
        entry.falloff_vertices = softKeys.length;
        if (keys.length === Object.keys(mesh.vertices).length) entry.note = 'The selection is the whole mesh, so the falloff has nothing to act on. Pass "select".';
        if (ops.some((o) => o.type === 'smooth')) entry.smooth_note = '"smooth" relaxes only the selected vertices; the falloff does not apply to it.';
      }
      report.push(entry);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  refreshElements(meshes, { geometry: true, uv: true, faces: true });
  Undo.finishEdit('MCP: Transform mesh', { elements: meshes });
  return { transformed: report, ops: ops.map((o) => o.type), falloff: falloff ?? undefined };
});
