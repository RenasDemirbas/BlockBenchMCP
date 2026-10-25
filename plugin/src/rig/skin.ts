// Bridge between Blockbench's weight storage and the pure WeightTable math.
// Blockbench keeps weights on the BONES (bone.vertex_weights, keyed
// "<mesh uuid prefix>:<vertex key>"); the math wants them per vertex.
import { WeightTable, V3 } from './weightmath';

export function readWeights(mesh: any, bones: any[]): WeightTable {
  const table: WeightTable = new Map();
  for (const vkey in mesh.vertices) {
    const row = new Map<string, number>();
    for (const bone of bones) {
      const w = bone.getVertexWeight(mesh, vkey);
      if (w > 0) row.set(bone.uuid, w);
    }
    table.set(vkey, row);
  }
  return table;
}

/** Write rows for `vkeys` (default: every row in the table); bones absent from a row are cleared. */
export function writeWeights(mesh: any, bones: any[], table: WeightTable, vkeys?: Iterable<string>) {
  for (const vkey of vkeys ?? table.keys()) {
    const row = table.get(vkey) || new Map();
    for (const bone of bones) bone.setVertexWeight(mesh, vkey, row.get(bone.uuid) || 0);
  }
}

export function worldVertices(mesh: any, vkeys?: string[]): Map<string, V3> {
  mesh.preview_controller.updateTransform(mesh);
  mesh.mesh.updateMatrixWorld(true);
  const out = new Map<string, V3>();
  const v = new THREE.Vector3();
  for (const vkey of vkeys ?? Object.keys(mesh.vertices)) {
    v.fromArray(mesh.vertices[vkey]);
    mesh.mesh.localToWorld(v);
    out.set(vkey, [v.x, v.y, v.z]);
  }
  return out;
}

export function refreshSkin(meshes: any[]) {
  Canvas.updateView({ elements: meshes, element_aspects: { geometry: true } });
}
