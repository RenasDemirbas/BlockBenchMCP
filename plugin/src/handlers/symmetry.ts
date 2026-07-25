// Symmetry tools: mirror elements across a plane, mirror keyframes between
// left/right bones (with phase offset for walk cycles), left/right renaming.
import { register, fail, requireProject } from '../registry';
import { resolveAnimation, resolveNode, refreshElements, vec3 } from '../util';

export const AXIS_INDEX: Record<string, number> = { x: 0, y: 1, z: 2 };

export function defaultMirrorCenter(): number {
  return Format.centered_grid ? 0 : 8;
}

function matchCase(sample: string, replacement: string): string {
  if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return replacement.toUpperCase();
  if (sample[0] === sample[0].toUpperCase() && sample[0] !== sample[0].toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** Swap left/right tokens in a name: left↔right, _l↔_r, l_↔r_, .l↔.r, trailing L/R. */
export function mirrorName(name: string): string {
  const swapped = name.replace(/left|right/gi, (m) =>
    matchCase(m, m.toLowerCase() === 'left' ? 'right' : 'left'));
  if (swapped !== name) return swapped;
  const swapLetter = (ch: string) => matchCase(ch, ch.toLowerCase() === 'l' ? 'r' : 'l');
  const suffix = name.match(/^(.*[_.\-])([lr])(\d*)$/i);
  if (suffix) return suffix[1] + swapLetter(suffix[2]) + suffix[3];
  const prefix = name.match(/^([lr])([_.\-].*)$/i);
  if (prefix) return swapLetter(prefix[1]) + prefix[2];
  return name;
}

/** Rotation reflection across the plane perpendicular to `axis`. */
export function reflectRotation(rotation: number[], axis: number): [number, number, number] {
  const r: [number, number, number] = [rotation[0], rotation[1], rotation[2]];
  for (let i = 0; i < 3; i++) {
    if (i !== axis) r[i] = -r[i];
  }
  return r;
}

const OPPOSITE_FACE: Record<string, string> = {
  north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up',
};
const AXIS_FACES: Record<number, [string, string]> = {
  0: ['east', 'west'],
  1: ['up', 'down'],
  2: ['north', 'south'],
};

/** Mirror one outliner node in place (no recursion — callers walk children). */
export function mirrorNodeInPlace(node: any, axis: number, center: number) {
  const reflect = (value: number) => 2 * center - value;
  if (node instanceof Cube) {
    const from = node.from.slice();
    const to = node.to.slice();
    node.from[axis] = reflect(to[axis]);
    node.to[axis] = reflect(from[axis]);
    node.origin[axis] = reflect(node.origin[axis]);
    node.rotation.replace(reflectRotation(node.rotation, axis));
    if (node.box_uv) {
      if (axis === 0) node.mirror_uv = !node.mirror_uv;
    } else {
      // Swap the two faces perpendicular to the mirror axis so textures stay
      // on the matching side. Plain snapshots, NOT getSaveCopy/extend:
      // getSaveCopy aliases the live uv array and omits default-valued props,
      // which would corrupt the swap. UV rects are reused as-is (limb reuse).
      const [fa, fb] = AXIS_FACES[axis];
      const A = node.faces[fa], B = node.faces[fb];
      const snap = (f: any) => ({
        uv: f.uv.slice(),
        rotation: f.rotation,
        tint: f.tint,
        cullface: f.cullface,
        material_name: f.material_name,
        enabled: f.enabled,
        texture: f.texture, // raw storage: uuid | false | null
      });
      const write = (face: any, s: any) => {
        face.uv.splice(0, face.uv.length, ...s.uv);
        face.rotation = s.rotation;
        face.tint = s.tint;
        face.cullface = s.cullface;
        face.material_name = s.material_name;
        face.enabled = s.enabled;
        face.texture = s.texture;
      };
      const a = snap(A), b = snap(B);
      write(A, b);
      write(B, a);
    }
  } else if (node instanceof Group) {
    node.origin[axis] = reflect(node.origin[axis]);
    node.rotation.replace(reflectRotation(node.rotation, axis));
  } else if (node instanceof Mesh) {
    node.origin[axis] = reflect(node.origin[axis]);
    node.rotation.replace(reflectRotation(node.rotation, axis));
    for (const vkey in node.vertices) {
      node.vertices[vkey][axis] = -node.vertices[vkey][axis];
    }
    for (const fkey in node.faces) {
      node.faces[fkey].vertices.reverse(); // flip winding so normals stay outward
    }
  } else {
    if (node.position) node.position[axis] = reflect(node.position[axis]);
    if (node.rotation?.length === 3) node.rotation.replace(reflectRotation(node.rotation, axis));
  }
}

function collectSubtree(node: any, out: any[]) {
  out.push(node);
  node.children?.forEach((c: any) => collectSubtree(c, out));
}

register('mirror_elements', (params) => {
  requireProject();
  if (!Array.isArray(params.ids) || !params.ids.length) fail('Pass "ids" — element/group uuids or names to mirror.');
  const axisName = params.axis || 'x';
  const axis = AXIS_INDEX[axisName];
  if (axis == null) fail(`Invalid axis "${params.axis}". Valid: x, y, z.`);
  const center = typeof params.center === 'number' ? params.center : defaultMirrorCenter();
  const duplicate = params.duplicate === true;
  const rename = params.rename !== false;

  const roots = params.ids.map((id: string) => resolveNode(id));
  // Drop nodes whose ancestor is also selected (they get mirrored via the subtree walk)
  const rootSet = new Set(roots);
  const topRoots = roots.filter((n: any) => {
    let p = n.parent;
    while (p && p !== 'root') {
      if (rootSet.has(p)) return false;
      p = p.parent;
    }
    return true;
  });

  // In-place mirroring mutates existing nodes — they MUST be in the undo
  // before-snapshot, or undo would delete them instead of restoring them.
  const preNodes: any[] = [];
  if (!duplicate) topRoots.forEach((r: any) => collectSubtree(r, preNodes));
  Undo.initEdit({
    outliner: true,
    elements: preNodes.filter((n) => n instanceof OutlinerElement),
    groups: preNodes.filter((n) => n instanceof Group),
    selection: true,
  });
  const produced: any[] = [];
  try {
    for (const root of topRoots) {
      // Capture original names BEFORE duplicating — duplicate() may already
      // rename the clone ("leg_left" → "leg_left2"), which would corrupt the
      // left/right token swap.
      const originalNames: string[] = [];
      const origList: any[] = [];
      collectSubtree(root, origList);
      origList.forEach((n) => originalNames.push(n.name));

      const target = duplicate ? root.duplicate() : root;
      const subtree: any[] = [];
      collectSubtree(target, subtree);
      subtree.forEach((node, i) => {
        mirrorNodeInPlace(node, axis, center);
        if (rename) {
          const original = originalNames[i] ?? node.name;
          const next = mirrorName(original);
          if (next !== original) {
            node.name = next;
            node.createUniqueName?.();
          } else if (duplicate) {
            node.createUniqueName?.();
          }
        }
      });
      produced.push(target);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  const flat: any[] = [];
  produced.forEach((n) => collectSubtree(n, flat));
  refreshElements(flat);
  Canvas.updateAllBones(flat.filter((n) => n instanceof Group));
  Canvas.updateAllUVs();
  Undo.finishEdit(duplicate ? 'MCP: Mirror-duplicate elements' : 'MCP: Mirror elements', {
    outliner: true,
    elements: flat.filter((n) => n instanceof OutlinerElement),
    groups: flat.filter((n) => n instanceof Group),
    selection: true,
  });
  return {
    mode: duplicate ? 'duplicated' : 'in_place',
    axis: axisName,
    center,
    affected: produced.map((n) => ({ name: n.name, uuid: n.uuid })),
  };
});

// ─────────────────────────── mirror_keyframes ───────────────────────────

function negate(value: any): any {
  if (typeof value === 'number') return -value;
  const str = String(value ?? '0').trim();
  if (!str || str === '0') return 0;
  if (/^-?\d+(\.\d+)?$/.test(str)) return -parseFloat(str);
  // Unwrap "-(expr)" only when the leading paren really closes at the end —
  // "-(a) * (b)" must NOT lose its outer negation.
  if (str.startsWith('-(') && str.endsWith(')')) {
    let depth = 0;
    let spansWhole = true;
    for (let i = 1; i < str.length; i++) {
      const c = str[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0 && i !== str.length - 1) { spansWhole = false; break; }
      }
    }
    if (spansWhole && depth === 0) return str.slice(2, -1);
  }
  return `-(${str})`;
}

/** Value transform for X-plane symmetry, per channel. */
function mirrorAxes(channel: string): [boolean, boolean, boolean] {
  if (channel === 'rotation') return [false, true, true]; // [x, -y, -z]
  if (channel === 'position') return [true, false, false]; // [-x, y, z]
  return [false, false, false]; // scale unchanged
}

function transformTriple(dp: any, flips: [boolean, boolean, boolean], mirror: boolean): { x: any; y: any; z: any } {
  const axes = ['x', 'y', 'z'] as const;
  const out: any = {};
  axes.forEach((axisKey, i) => {
    const v = dp[axisKey];
    out[axisKey] = mirror && flips[i] ? negate(v) : v;
  });
  return out;
}

register('mirror_keyframes', (params) => {
  requireProject();
  if (!Format.animation_mode) fail(`Format "${Format.id}" does not support animations.`);
  const anim = resolveAnimation(params.animation);
  const mirrorValues = params.mirror_values !== false;
  const replace = params.replace !== false;
  const wrap = params.wrap !== false;
  const channels: string[] = Array.isArray(params.channels) && params.channels.length
    ? params.channels
    : ['rotation', 'position', 'scale'];
  const globalPhase = params.phase_offset ?? 0;
  const len = anim.length || anim.getMaxLength() || 0;

  // Resolve mappings — explicit, or auto-paired by left/right name tokens.
  let mappings: { from: string; to: string; phase_offset?: number }[] = Array.isArray(params.mappings) ? params.mappings.slice() : [];
  const skipped: string[] = [];
  if (!mappings.length) {
    for (const key in anim.animators) {
      if (key === 'effects') continue;
      const animator = anim.animators[key];
      if (!animator.keyframes.length || !animator.name) continue;
      const partner = mirrorName(animator.name);
      if (partner === animator.name) continue;
      const partnerGroup = Project.groups.find((g: any) => g.name === partner)
        || Project.groups.find((g: any) => g.name.toLowerCase() === partner.toLowerCase());
      if (!partnerGroup) { skipped.push(`${animator.name} (no bone named "${partner}")`); continue; }
      const partnerAnimator = anim.animators[partnerGroup.uuid];
      if (partnerAnimator && partnerAnimator.keyframes.length) {
        skipped.push(`${animator.name} → ${partner} (target already has keyframes; pass explicit mappings to overwrite)`);
        continue;
      }
      mappings.push({ from: animator.name, to: partner });
    }
    if (!mappings.length) {
      fail(`No left/right bone pairs could be auto-detected in "${anim.name}"${skipped.length ? ` (skipped: ${skipped.join('; ')})` : ''}. Pass explicit "mappings": [{from, to, phase_offset?}].`);
    }
  }

  // Snapshot all source keyframes BEFORE writing anything, so swap mappings
  // (left→right AND right→left) read consistent data.
  const snapshots = mappings.map((m) => {
    const srcNode = resolveNode(m.from);
    const srcAnimator = anim.animators[srcNode.uuid];
    if (!srcAnimator || !srcAnimator.keyframes.length) {
      fail(`Bone "${m.from}" has no keyframes in "${anim.name}". See get_animation.`);
    }
    return {
      mapping: m,
      dstNode: resolveNode(m.to),
      keyframes: srcAnimator.keyframes
        .filter((kf: any) => kf.transform && channels.includes(kf.channel))
        .map((kf: any) => ({
          time: kf.time,
          channel: kf.channel,
          interpolation: kf.interpolation,
          uniform: kf.uniform,
          data_points: kf.data_points.map((dp: any) => ({ x: dp.x, y: dp.y, z: dp.z })),
          bezier: kf.interpolation === 'bezier' ? {
            left_time: kf.bezier_left_time.slice(),
            left_value: kf.bezier_left_value.slice(),
            right_time: kf.bezier_right_time.slice(),
            right_value: kf.bezier_right_value.slice(),
            linked: kf.bezier_linked,
          } : null,
        })),
    };
  });

  Undo.initEdit({ animations: [anim] });
  const summary: any[] = [];
  try {
    for (const snap of snapshots) {
      const dstAnimator = anim.getBoneAnimator(snap.dstNode);
      if (!dstAnimator) fail(`Could not create an animator for "${snap.mapping.to}".`);
      const phase = snap.mapping.phase_offset ?? globalPhase;
      const byChannel: Record<string, any[]> = {};
      for (const kf of snap.keyframes) (byChannel[kf.channel] ??= []).push(kf);

      let copied = 0;
      for (const channel of Object.keys(byChannel)) {
        if (replace) {
          [...dstAnimator[channel]].forEach((kf: any) => kf.remove());
        }
        const flips = mirrorAxes(channel);
        // Shift + wrap times into [0, len), tracking which values land at 0 so
        // the loop endpoint can be reconstructed afterwards.
        const placed: { time: number; src: any }[] = [];
        for (const src of byChannel[channel]) {
          let t = src.time + phase;
          if (wrap && len > 0) {
            t = ((t % len) + len) % len;
            if (Math.abs(t) < 1e-9) t = 0;
          }
          placed.push({ time: t, src });
        }
        // Loop continuity: if wrapping created a keyframe at 0 but none at len,
        // duplicate the 0-keyframe at len (bedrock loops need matching
        // endpoints). Applies to phase 0 too: the source's own t=len keyframe
        // wraps onto t=0 and would otherwise vanish from the loop end.
        if (wrap && len > 0) {
          const atZero = placed.find((p) => p.time === 0);
          const atLen = placed.some((p) => Math.abs(p.time - len) < 1e-9);
          if (atZero && !atLen) placed.push({ time: len, src: atZero.src });
        }
        for (const p of placed) {
          const dataPoints = p.src.data_points.map((dp: any) => transformTriple(dp, flips, mirrorValues));
          const kf = dstAnimator.addKeyframe({
            time: Timeline.snapTime(p.time, anim),
            channel,
            interpolation: p.src.interpolation,
            uniform: p.src.uniform,
            data_points: dataPoints,
          });
          if (p.src.bezier) {
            kf.bezier_left_time.replace(p.src.bezier.left_time);
            kf.bezier_right_time.replace(p.src.bezier.right_time);
            const lv = p.src.bezier.left_value.slice();
            const rv = p.src.bezier.right_value.slice();
            if (mirrorValues) {
              const flips2 = mirrorAxes(channel);
              for (let i = 0; i < 3; i++) {
                if (flips2[i]) { lv[i] = -lv[i]; rv[i] = -rv[i]; }
              }
            }
            kf.bezier_left_value.replace(lv);
            kf.bezier_right_value.replace(rv);
            if (p.src.bezier.linked != null) kf.bezier_linked = p.src.bezier.linked;
          }
          kf.replaceOthers([]);
          copied++;
        }
      }
      dstAnimator.addToTimeline();
      summary.push({ from: snap.mapping.from, to: snap.mapping.to, phase_offset: phase, keyframes: copied });
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  anim.setLength(Math.max(anim.length, anim.getMaxLength()));
  Undo.finishEdit('MCP: Mirror keyframes', { animations: [anim] });
  Animator.preview();
  return {
    animation: anim.name,
    mirrored: summary,
    skipped: skipped.length ? skipped : undefined,
    note: mirrorValues ? 'Values were X-mirrored: rotation [x,-y,-z], position [-x,y,z], scale unchanged.' : 'Values copied verbatim (mirror_values: false).',
  };
});
