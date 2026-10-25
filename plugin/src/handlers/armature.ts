// add_armature: build an armature (skeleton of bones, Blockbench 5 "free"
// format) from head/tail points, and attach meshes to it so they can be
// skinned with vertex weights (./weights) and posed or IK-driven per bone.
import { register, fail } from '../registry';
import { resolveNode, vec3, cancelCreate } from '../util';
import {
  requireArmatureSupport, resolveArmature, isArmatureBone, toParentSpace, aimRotation,
  refreshBoneMatrices, ensureRestPose, describeBone,
} from '../rig/armature';
import { autoWeights } from './weights';

/** Parent of a new bone: a bone made earlier in this call, an existing bone, or the armature itself. */
function boneParent(def: any, armature: any, made: Map<string, any>): any {
  if (!def.parent) return armature;
  const key = String(def.parent).toLowerCase();
  if (made.has(key)) return made.get(key);
  const node = resolveNode(def.parent);
  if (node === armature) return armature;
  if (!isArmatureBone(node) || node.getArmature() !== armature) {
    fail(`Bone "${def.name}": parent "${def.parent}" is not a bone of armature "${armature.name}".`);
  }
  return node;
}

function createBone(def: any, armature: any, made: Map<string, any>): any {
  if (!def.name) fail('Every bone needs a "name".');
  if (made.has(String(def.name).toLowerCase())) fail(`Bone name "${def.name}" is used twice in this call.`);
  const parent = boneParent(def, armature, made);
  const head = vec3(def.head);
  if (!head) fail(`Bone "${def.name}" needs a "head" — its start point in model units.`);
  const tail = vec3(def.tail);
  const data: any = {
    name: def.name,
    origin: toParentSpace(parent, head),
    width: def.width,
    connected: def.connected,
    color: def.color,
  };
  if (tail) {
    data.length = Math.hypot(tail[0] - head[0], tail[1] - head[1], tail[2] - head[2]);
    if (data.length < 1e-6) fail(`Bone "${def.name}": head and tail are the same point.`);
    data.rotation = aimRotation(parent, head, tail);
  } else {
    data.length = def.length ?? 8;
    data.rotation = vec3(def.rotation) ?? [0, 0, 0];
  }
  const bone = new ArmatureBone(data).addTo(parent).init();
  bone.isOpen = true;
  ArmatureBone.preview_controller.updateTransform(bone);
  made.set(String(def.name).toLowerCase(), bone);
  return bone;
}

register('add_armature', (params) => {
  requireArmatureSupport('add_armature');
  const boneDefs: any[] = Array.isArray(params.bones) ? params.bones : [];
  const meshIds: string[] = Array.isArray(params.meshes) ? params.meshes : [];
  if (!boneDefs.length && !meshIds.length) fail('Pass "bones": [{name, head, tail?, parent?}] and/or "meshes": [...] to attach.');
  // Heads and tails are rest-pose positions; an animated pose would skew them.
  ensureRestPose();

  const created: any[] = [];
  const bones: any[] = [];
  const meshes: any[] = [];
  const previousParents: [any, any][] = [];
  Undo.initEdit({ outliner: true, elements: [], selection: true });
  let armature: any;
  try {
    if (params.armature) {
      armature = resolveArmature(params.armature);
    } else {
      armature = new Armature({ name: params.name || 'armature' }).init();
      armature.isOpen = true;
      created.push(armature);
    }
    const made = new Map<string, any>();
    for (const def of boneDefs) {
      const bone = createBone(def, armature, made);
      created.push(bone);
      bones.push(bone);
    }
    for (const id of meshIds) {
      const mesh = resolveNode(id);
      if (!(mesh instanceof Mesh)) fail(`"${mesh.name}" is a ${mesh.type}; only meshes can be skinned. Convert cubes with run_action "convert_to_mesh" first.`);
      // Mesh coordinates are model-space and the armature has no transform, so
      // re-parenting keeps the mesh where it is.
      previousParents.push([mesh, mesh.parent]);
      mesh.addTo(armature);
      meshes.push(mesh);
    }
  } catch (err) {
    for (const [mesh, parent] of previousParents) mesh.addTo(parent);
    cancelCreate(created);
    throw err;
  }
  refreshBoneMatrices(armature);
  Canvas.updateView({ elements: [...created, ...meshes], element_aspects: { transform: true, geometry: true } });
  Undo.finishEdit('MCP: Add armature', { outliner: true, elements: [...created, ...meshes], selection: true });

  const out: any = {
    armature: armature.name,
    uuid: armature.uuid,
    bones: armature.getAllBones().map(describeBone),
    added_bones: bones.map((b) => b.name),
    attached_meshes: meshes.length ? meshes.map((m) => m.name) : undefined,
  };
  const wantWeights = params.auto_weights ?? meshes.length > 0;
  if (wantWeights && meshes.length && armature.getAllBones().length) {
    out.weights = autoWeights(meshes, { method: params.weight_method, blend: params.blend, max_bones: params.max_bones });
  }
  out.next = 'Check the skin with capture_screenshot {view_mode: "weighted_bone_colors"}, fix joints with vertex_weights (set / smooth), then pose bones with set_keyframes (bone = bone name) or rig them with add_ik_controllers.';
  return out;
});
