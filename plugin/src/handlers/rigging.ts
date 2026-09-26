// Inverse kinematics: null-object IK controllers with (5.2+) pole targets,
// and baking the solved IK into plain rotation keyframes for export.
import { register, fail, requireProject } from '../registry';
import { resolveNode, resolveParent, resolveAnimation, vec3, refreshElements } from '../util';
import { applyIkFields } from './elements';

function requireIkSupport() {
  requireProject();
  if (typeof NullObject === 'undefined' || !Format.animation_mode) {
    fail(`IK controllers are null objects, which only exist in animated formats. "${Format.id}" has no animation mode — use "bedrock" or "free".`);
  }
}

/** Absolute (model-space) pivot of a chain node at rest. */
function restPivot(node: any): [number, number, number] {
  if (node instanceof Group) return node.origin.slice();
  if (node.position) return node.position.slice();
  const p = node.getWorldCenter?.();
  if (p) return [p.x, p.y, p.z];
  fail(`Cannot determine the position of "${node.name}".`);
}

/** The bones the solver will rotate, root first — mirrors NullObjectAnimator.displayIK. */
function chainOf(target: any, source: any, sourceIncluded: boolean): any[] {
  const bones: any[] = [];
  let current = target;
  while (current && current !== source && current !== 'root') {
    bones.push(current);
    current = current.parent;
  }
  if (sourceIncluded && source && source !== 'root') bones.push(source);
  return bones.reverse();
}

register('add_ik_controllers', (params) => {
  requireIkSupport();
  const defs: any[] = Array.isArray(params.controllers) ? params.controllers : [];
  if (!defs.length) fail('Pass "controllers": [{name, target, source?, position?, pole?, pole_position?, pole_offset?}].');
  const hasPoles = !!NullObject.properties?.ik_pole;

  const animations: any[] = [];
  const created: any[] = [];
  const report: any[] = [];
  Undo.initEdit({ outliner: true, elements: [], selection: true, animations: Animation.all.slice() });
  try {
    for (const def of defs) {
      if (!def.target) fail(`Controller "${def.name || '?'}" needs a "target" — the bone (or locator) at the END of the chain, e.g. the foot or hand.`);
      const target = resolveNode(def.target);
      const parent = resolveParent(def.parent);
      const source = def.source ? resolveNode(def.source) : null;
      if (source && !(source instanceof Group)) fail(`"source" must be a bone (group); "${source.name}" is a ${source.type}.`);

      const controller = new NullObject({
        name: def.name || `${target.name}_ik`,
        position: vec3(def.position) ?? restPivot(target),
      });
      if (parent !== 'root') controller.addTo(parent);
      controller.init();
      controller.createUniqueName?.();
      created.push(controller);

      // Pole: an existing node, or a new null placed at pole_position /
      // at the chain's middle joint + pole_offset.
      let poleId = def.pole;
      const chain = chainOf(target, source ?? (parent === 'root' ? 'root' : parent), !!source);
      if (def.pole_position || def.pole_offset) {
        if (!hasPoles) fail(`IK poles need Blockbench 5.2 or newer (this is ${Blockbench.version}).`);
        let at = vec3(def.pole_position);
        if (!at) {
          if (chain.length < 2) fail(`pole_offset needs a chain of at least 2 bones; "${target.name}" gives ${chain.length}. Pass "source" or "pole_position".`);
          const middle = chain[Math.floor((chain.length - 1) / 2)];
          const off = vec3(def.pole_offset)!;
          const mid = restPivot(middle);
          at = [mid[0] + off[0], mid[1] + off[1], mid[2] + off[2]];
        }
        const pole = new NullObject({ name: `${controller.name}_pole`, position: at });
        if (parent !== 'root') pole.addTo(parent);
        pole.init();
        pole.createUniqueName?.();
        created.push(pole);
        poleId = pole.uuid;
      }

      applyIkFields(controller, {
        ik_target: target.uuid,
        ik_source: source ? source.uuid : undefined,
        ik_pole: poleId,
        lock_ik_target_rotation: def.lock_rotation,
      });

      // Blockbench 5.2.1+ only runs a controller in animations where it has
      // keyframes; a zero offset at t=0 switches it on without moving it.
      const wanted = def.animations === 'all' ? Animation.all : (def.animations || []).map((id: string) => resolveAnimation(id));
      for (const anim of wanted) {
        const animator = anim.getBoneAnimator(controller);
        if (!animator.position.length) animator.addKeyframe({ channel: 'position', time: 0, data_points: [{ x: 0, y: 0, z: 0 }] });
        animations.safePush(anim);
      }

      const entry: any = {
        controller: controller.name,
        uuid: controller.uuid,
        target: target.name,
        chain: chain.map((b: any) => b.name),
        position: controller.position.slice(),
        pole: poleId ? (OutlinerNode.uuids[poleId]?.name ?? poleId) : undefined,
        active_in: wanted.length ? wanted.map((a: any) => a.name) : undefined,
      };
      if (!source) {
        entry.warning = `No "source": the chain runs from ${parent === 'root' ? 'the TOP-LEVEL bone' : `"${parent.name}"`} down to "${target.name}" (${chain.length} bones), so every one of them bends. Pass "source" (e.g. the thigh or upper arm) to limit it.`;
      }
      if (chain.length < 2) entry.warning = `${entry.warning ? entry.warning + ' ' : ''}The chain has fewer than 2 bones — there is nothing to bend. Set "source" to a bone at least two levels above the target.`;
      report.push(entry);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  refreshElements(created);
  Undo.finishEdit('MCP: Add IK controllers', { outliner: true, elements: created, selection: true, animations: Animation.all.slice() });
  if (Modes.animate) Animator.preview();
  return {
    controllers: report,
    how_to_animate: 'Keyframe the controller\'s POSITION (set_keyframes, channel "position", bone = controller name) — the chain follows. Values are offsets from where the controller was placed. Use bake_ik_animation before exporting to formats without IK (Bedrock, Java).',
    note: 'Blockbench 5.2.1+ only applies a controller in animations where it has at least one keyframe ("animations" adds a neutral one).',
  };
});

register('bake_ik_animation', (params) => {
  requireIkSupport();
  const anim = resolveAnimation(params.animation);
  const controllers = NullObject.all.filter((n: any) => n.ik_target);
  if (!controllers.length) fail('There are no IK controllers (null objects with an ik_target) to bake. Create them with add_ik_controllers.');
  const action = BarItems.bake_ik_animation;
  if (!action) fail(`This Blockbench (${Blockbench.version}) has no "Bake IK" action.`);

  if (Mode.selected?.id !== 'animate') Modes.options.animate.select();
  anim.select();
  const countRotation = () => {
    const out: Record<string, number> = {};
    for (const key in anim.animators) {
      const a = anim.animators[key];
      if (a.rotation?.length) out[a.name || key] = a.rotation.length;
    }
    return out;
  };
  const before = countRotation();
  action.click();
  const after = countRotation();
  const added: Record<string, number> = {};
  for (const bone in after) {
    const diff = after[bone] - (before[bone] || 0);
    if (diff > 0) added[bone] = diff;
  }

  if (params.detach_controllers) {
    // The solver keeps overriding the chain in the preview; unhook it so what
    // you see is the baked keyframes — which is what an exporter sees too.
    Undo.initEdit({ elements: controllers });
    controllers.forEach((n: any) => { n.ik_target = ''; });
    Undo.finishEdit('MCP: Detach IK controllers', { elements: controllers });
    Animator.preview();
  }
  return {
    animation: anim.name,
    rotation_keyframes_added: added,
    detached: params.detach_controllers ? controllers.map((n: any) => n.name) : undefined,
    note: Object.keys(added).length
      ? 'IK is now baked into rotation keyframes on the chain bones (sampled at the animation\'s snapping fps).'
      : 'No keyframes were added — the controllers may not move in this animation, or (5.2.1+) they have no keyframes in it.',
  };
});
