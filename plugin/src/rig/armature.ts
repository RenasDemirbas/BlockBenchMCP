// Armature rigs (Blockbench "free" format): lookups and bone geometry shared by
// the armature, vertex weight and IK handlers. A bone's origin is its HEAD,
// relative to the parent bone; the bone points along its local +Y, so the
// tail is the connected child's head or `length` units up local +Y.
import { fail, requireProject } from '../registry';
import { resolveNode } from '../util';

export type V3 = [number, number, number];

export const hasArmatures = () => typeof Armature !== 'undefined' && typeof ArmatureBone !== 'undefined';

export function requireArmatureSupport(context: string) {
  requireProject();
  if (!hasArmatures()) fail(`${context}: armatures need Blockbench 5.0 or newer (this is ${Blockbench.version}).`);
  if (!Format.armature_rig) fail(`${context}: format "${Format.id}" has no armatures. Use the generic "free" format (create_project format "free").`);
}

export const isArmatureBone = (n: any) => hasArmatures() && n instanceof ArmatureBone;
export const isArmature = (n: any) => hasArmatures() && n instanceof Armature;

export function resolveArmature(id: string): any {
  const node = resolveNode(id);
  if (isArmature(node)) return node;
  if (isArmatureBone(node)) return node.getArmature();
  if (node instanceof Mesh && node.getArmature?.()) return node.getArmature();
  fail(`"${node.name}" is a ${node.type}, not an armature (or a bone/mesh inside one). Create one with add_armature.`);
}

export function resolveBone(id: string, armature?: any): any {
  const node = resolveNode(id);
  if (!isArmatureBone(node)) fail(`"${node.name}" is a ${node.type}, not an armature bone. List bones with list_outline.`);
  if (armature && node.getArmature() !== armature) fail(`Bone "${node.name}" belongs to armature "${node.getArmature()?.name}", not "${armature.name}".`);
  return node;
}

/** A mesh that is skinned by an armature (a child of it). */
export function resolveSkinnedMesh(id: string): any {
  const node = resolveNode(id);
  if (!(node instanceof Mesh)) fail(`"${node.name}" is a ${node.type}, not a mesh. Vertex weights only exist on meshes.`);
  if (!node.getArmature?.()) fail(`Mesh "${node.name}" is not inside an armature. Attach it first: add_armature {armature, meshes: ["${node.name}"]}.`);
  return node;
}

/** Every skinned mesh of the project, or of one armature. */
export function skinnedMeshes(armature?: any): any[] {
  return (Mesh.all as any[]).filter((m) => {
    const a = m.getArmature?.();
    return a && (!armature || a === armature);
  });
}

/** World-space matrices of bones are only right after the scene graph is updated. */
export function refreshBoneMatrices(armature: any) {
  for (const bone of armature.getAllBones()) ArmatureBone.preview_controller.updateTransform(bone);
  armature.scene_object?.updateMatrixWorld(true);
}

/**
 * Bone positions are only the REST pose in edit mode — in animate mode they
 * carry the current animation frame. Weight math must run on the rest pose.
 */
export function ensureRestPose() {
  if (!Modes.edit) Modes.options.edit.select();
  for (const armature of Armature.all as any[]) refreshBoneMatrices(armature);
}

export function boneHead(bone: any): V3 {
  return bone.getWorldCenter().toArray() as V3;
}

/** Where the bone ends: its first child's head, else `length` along local +Y. */
export function boneTail(bone: any): V3 {
  const local = new THREE.Vector3(0, bone.length ?? 8, 0);
  const child = bone.children?.find((c: any) => isArmatureBone(c));
  if (child) local.fromArray(child.origin);
  return bone.scene_object.localToWorld(local).toArray() as V3;
}

/** Turn a model-space point into the coordinates a child of `parent` uses. */
export function toParentSpace(parent: any, point: V3): V3 {
  if (!isArmatureBone(parent)) return point.slice() as V3;
  parent.scene_object.updateMatrixWorld(true);
  return parent.scene_object.worldToLocal(new THREE.Vector3(...point)).toArray() as V3;
}

/**
 * Euler rotation (degrees, Format.euler_order) that makes a bone at `head`
 * point toward `tail`, expressed in the parent's space.
 */
export function aimRotation(parent: any, head: V3, tail: V3): V3 {
  const a = new THREE.Vector3(...toParentSpace(parent, head));
  const b = new THREE.Vector3(...toParentSpace(parent, tail));
  const dir = b.sub(a);
  if (dir.lengthSq() < 1e-12) return [0, 0, 0];
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  const e = new THREE.Euler().setFromQuaternion(q, Format.euler_order || 'ZYX');
  const deg = (r: number) => Math.round(THREE.MathUtils.radToDeg(r) * 1000) / 1000;
  return [deg(e.x), deg(e.y), deg(e.z)];
}

export function describeBone(bone: any): any {
  return {
    name: bone.name,
    uuid: bone.uuid,
    parent: isArmatureBone(bone.parent) ? bone.parent.name : null,
    head: boneHead(bone).map(round),
    tail: boneTail(bone).map(round),
    length: round(bone.length),
    connected: !!bone.connected,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
