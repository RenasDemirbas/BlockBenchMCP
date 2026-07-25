// Animation: create/edit animations, full keyframe control (bones = groups),
// effect keyframes, presets, posing for screenshots.
import { register, fail, requireProject } from '../registry';
import { resolveAnimation, resolveNode, clampInt } from '../util';
import { takeScreenshot } from './camera';

function requireAnimationSupport() {
  requireProject();
  if (!Format.animation_mode) {
    fail(`The current format "${Format.id}" does not support animations. Use "bedrock" (entity) or "free" format. bedrock_block and java_block are static geometry formats.`);
  }
}

function resolveAnimatableNode(id: string): any {
  const node = resolveNode(id);
  if (!node.constructor.animator) {
    fail(`"${node.name}" is a ${node.type} and cannot be animated directly. In Blockbench, GROUPS are the animatable bones — put cubes in a group and animate the group. Use add_groups + update_elements(parent) to structure the model.`);
  }
  return node;
}

function ensureAnimateMode() {
  if (Mode.selected?.id !== 'animate' && Modes.options.animate?.condition?.() !== false) {
    try { Modes.options.animate.select(); } catch {}
  }
}

function describeKeyframe(kf: any) {
  const out: any = {
    uuid: kf.uuid,
    time: kf.time,
    channel: kf.channel,
    interpolation: kf.interpolation,
    values: kf.data_points[0] && kf.transform
      ? [kf.data_points[0].x, kf.data_points[0].y, kf.data_points[0].z]
      : undefined,
  };
  if (kf.data_points.length > 1 && kf.transform) {
    out.post_values = [kf.data_points[1].x, kf.data_points[1].y, kf.data_points[1].z];
  }
  if (!kf.transform && kf.data_points[0]) {
    const dp = kf.data_points[0];
    out.data = { effect: dp.effect, locator: dp.locator, script: dp.script, file: dp.file };
  }
  if (kf.interpolation === 'bezier') {
    out.bezier = {
      left_time: kf.bezier_left_time.slice(),
      left_value: kf.bezier_left_value.slice(),
      right_time: kf.bezier_right_time.slice(),
      right_value: kf.bezier_right_value.slice(),
    };
  }
  return out;
}

function describeAnimation(anim: any, deep = false) {
  const out: any = {
    uuid: anim.uuid,
    name: anim.name,
    loop: anim.loop,
    length: anim.length,
    snapping: anim.snapping,
    override: anim.override,
    selected: anim.selected,
  };
  if (anim.anim_time_update) out.anim_time_update = anim.anim_time_update;
  if (anim.blend_weight) out.blend_weight = anim.blend_weight;
  const animators: any = {};
  for (const key in anim.animators) {
    const animator = anim.animators[key];
    if (!animator.keyframes.length) continue;
    const label = key === 'effects' ? 'effects' : (animator.name || key);
    animators[label] = deep
      ? {
        uuid: key,
        type: animator.type,
        keyframes: [...animator.keyframes].sort((a: any, b: any) => a.time - b.time).map(describeKeyframe),
      }
      : { uuid: key, type: animator.type, keyframe_count: animator.keyframes.length };
  }
  out.animators = animators;
  return out;
}

register('create_animation', (params) => {
  requireAnimationSupport();
  if (!params.name) fail('Pass a "name" for the animation (e.g. "animation.robot.walk").');
  const anim = new Animation({
    name: params.name,
    loop: ['once', 'loop', 'hold'].includes(params.loop) ? params.loop : (params.loop === true ? 'loop' : 'once'),
    length: params.length ?? 0,
    snapping: clampInt(params.snapping ?? 24, 10, 500),
    override: params.override === true,
    anim_time_update: params.anim_time_update || '',
    blend_weight: params.blend_weight || '',
    start_delay: params.start_delay || '',
    loop_delay: params.loop_delay || '',
  });
  Undo.initEdit({ animations: [] });
  anim.add(false);
  Undo.finishEdit('MCP: Create animation', { animations: [anim] });
  ensureAnimateMode();
  anim.select();
  return describeAnimation(anim);
});

register('list_animations', () => {
  requireProject();
  return Animation.all.map((a: any) => describeAnimation(a, false));
});

register('get_animation', (params) => {
  requireProject();
  return describeAnimation(resolveAnimation(params.id), true);
});

register('update_animation', (params) => {
  requireProject();
  const anim = resolveAnimation(params.id);
  Undo.initEdit({ animations: [anim] });
  const data: any = {};
  for (const key of ['name', 'loop', 'length', 'snapping', 'override', 'anim_time_update', 'blend_weight', 'start_delay', 'loop_delay']) {
    if (params[key] !== undefined) data[key] = params[key];
  }
  anim.extend(data);
  anim.createUniqueName();
  // extend() clamps length up to the last keyframe, so asking for a SHORTER
  // clip silently did nothing. Honour the request and name the keyframes that
  // are now past the end rather than quietly stretching back out.
  let trailing: string[] | undefined;
  if (data.length != null && anim.length !== data.length) {
    anim.setLength(data.length);           // keeps the timeline UI in sync
    if (anim.length !== data.length) {     // …then defeat its clamp-to-content
      anim.length = data.length;
      if (Animation.selected === anim) {
        try {
          Timeline.vue._data.animation_length = anim.length;
          BarItems.slider_animation_length.update();
        } catch { /* timeline panel not mounted */ }
      }
    }
    trailing = [];
    for (const key in anim.animators) {
      for (const kf of anim.animators[key].keyframes) {
        if (kf.time > data.length + 1e-6) {
          trailing.push(`${anim.animators[key].name || key}.${kf.channel}@${Math.round(kf.time * 100000) / 100000}s`);
        }
      }
    }
  }
  Undo.finishEdit('MCP: Update animation', { animations: [anim] });
  Animator.preview();
  const out = describeAnimation(anim);
  if (trailing?.length) {
    out.warning = `${trailing.length} keyframe(s) now sit PAST the animation length ${data.length}s and will not play: ${trailing.slice(0, 10).join(', ')}${trailing.length > 10 ? ', …' : ''}. Move them with edit_keyframes (set_time / time_offset / time_scale, "snap": false for exact times) or delete them.`;
  }
  return out;
});

register('delete_animation', (params) => {
  requireProject();
  const anim = resolveAnimation(params.id);
  const name = anim.name;
  anim.remove(true, false);
  return { deleted: name };
});

function normalizeValues(values: any, channel: string): { x: any; y: any; z: any } {
  const def = channel === 'scale' ? 1 : 0;
  if (values == null) return { x: def, y: def, z: def };
  if (typeof values === 'number' || typeof values === 'string') return { x: values, y: values, z: values };
  if (Array.isArray(values)) {
    if (values.length !== 3) fail(`Keyframe "values" must have 3 entries [x, y, z], got ${JSON.stringify(values)}`);
    return { x: values[0], y: values[1], z: values[2] };
  }
  fail(`Invalid keyframe values: ${JSON.stringify(values)}. Use [x,y,z] (numbers or Molang strings) or a single number.`);
}

/**
 * Blockbench quantises keyframe times to the animation's FPS grid
 * (`snapping`, default 24). At 24 fps a requested 0.3 s lands on 0.29167 and
 * 1.2 s lands on 1.20833 — which silently pushes the last keyframe PAST the
 * intended animation length. Keyframe.time is a plain float, so opting out is
 * safe; either way the caller is told what actually happened.
 */
function placeTime(requested: number, anim: any, snap: boolean): number {
  return snap ? Timeline.snapTime(requested, anim) : requested;
}

/**
 * Time of the last keyframe. Blockbench's own `getMaxLength()` seeds its
 * accumulator with `this.length` (js/animations/animation.js), so it answers
 * "how long must this clip be" and can never come back SHORTER than the current
 * length — which is exactly why a retimed animation could not be shrunk. Zeroing
 * length around the call is what `setLength` itself does, and it keeps the
 * app's own rules (e.g. a trailing catmullrom keyframe does not count).
 */
function contentLength(anim: any): number {
  const saved = anim.length;
  anim.length = 0;
  try {
    return anim.getMaxLength();
  } finally {
    anim.length = saved;
  }
}

function snapReport(moved: { bone: string; channel: string; requested: number; time: number }[], anim: any) {
  if (!moved.length) return undefined;
  return {
    snapping_fps: anim.snapping,
    moved: moved.map((m) => `${m.bone}.${m.channel} ${m.requested}s → ${Math.round(m.time * 100000) / 100000}s`),
    hint: `Times were quantised to the animation's ${anim.snapping} fps grid. Pass "snap": false to write exact times, or set the animation's "snapping" so your times land on the grid (update_animation).`,
  };
}

register('set_keyframes', (params) => {
  requireAnimationSupport();
  const anim = resolveAnimation(params.animation);
  if (!Array.isArray(params.bones) || !params.bones.length) {
    fail('Pass "bones": [{bone, channel: rotation|position|scale, keyframes: [{time, values, interpolation?, post_values?, bezier?}], replace?}]');
  }
  ensureAnimateMode();
  anim.select();
  Undo.initEdit({ animations: [anim] });
  const summary: any[] = [];
  const moved: { bone: string; channel: string; requested: number; time: number }[] = [];
  try {
    for (const boneDef of params.bones) {
      const node = resolveAnimatableNode(boneDef.bone);
      const animator = anim.getBoneAnimator(node);
      if (!animator) fail(`Could not create an animator for "${boneDef.bone}".`);
      const channel = boneDef.channel;
      if (!animator.channels[channel]) {
        fail(`Invalid channel "${channel}" for ${node.type} "${node.name}". Valid channels: ${Object.keys(animator.channels).join(', ')}`);
      }
      const snap = (boneDef.snap ?? params.snap) !== false;
      if (boneDef.replace) {
        [...animator[channel]].forEach((kf: any) => kf.remove());
      }
      const created: any[] = [];
      for (const kfDef of boneDef.keyframes || []) {
        if (typeof kfDef.time !== 'number') fail('Each keyframe needs a numeric "time" in seconds.');
        const first = normalizeValues(kfDef.values, channel);
        const dataPoints: any[] = [first];
        if (kfDef.post_values != null) dataPoints.push(normalizeValues(kfDef.post_values, channel));
        const time = placeTime(kfDef.time, anim, (kfDef.snap ?? snap) !== false);
        if (Math.abs(time - kfDef.time) > 1e-9) {
          moved.push({ bone: node.name, channel, requested: kfDef.time, time });
        }
        const kf = animator.addKeyframe({
          time,
          channel,
          interpolation: kfDef.interpolation || 'linear',
          uniform: kfDef.uniform,
          data_points: dataPoints,
        });
        if (kfDef.bezier) {
          if (kfDef.bezier.left_time) kf.bezier_left_time.replace(kfDef.bezier.left_time);
          if (kfDef.bezier.left_value) kf.bezier_left_value.replace(kfDef.bezier.left_value);
          if (kfDef.bezier.right_time) kf.bezier_right_time.replace(kfDef.bezier.right_time);
          if (kfDef.bezier.right_value) kf.bezier_right_value.replace(kfDef.bezier.right_value);
          if (kfDef.bezier.linked != null) kf.bezier_linked = kfDef.bezier.linked;
        }
        kf.replaceOthers([]);
        created.push(kf);
      }
      animator.addToTimeline();
      const entry: any = {
        bone: node.name,
        channel,
        keyframes: created.length,
        times: created.map((kf: any) => Math.round(kf.time * 100000) / 100000),
      };
      // Keyframe values are DELTAS on top of the bone's rest transform — a bone
      // modelled at rest rotation [0,90,0] animated to [0,0,0] still sits at 90.
      // That is invisible unless you render, so say it up front.
      const rest = channel === 'rotation' ? node.rotation : (channel === 'position' ? null : null);
      if (rest && rest.some((v: number) => Math.abs(v) > 1e-6)) {
        entry.rest_rotation = rest.slice();
        entry.rest_note = `Bone "${node.name}" has a non-zero REST rotation ${JSON.stringify(rest.slice())}. Animation values ADD to it, so these keyframes are offsets from that pose, not absolute world angles.`;
      }
      summary.push(entry);
    }
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  anim.setLength(Math.max(anim.length, anim.getMaxLength()));
  Undo.finishEdit('MCP: Set keyframes', { animations: [anim] });
  Animator.preview();
  return { animation: anim.name, length: anim.length, bones: summary, snapped: snapReport(moved, anim) };
});

register('edit_keyframes', (params) => {
  requireAnimationSupport();
  const anim = resolveAnimation(params.animation);
  const range: [number, number] = params.time_range || [-Infinity, Infinity];
  const targets: any[] = [];
  for (const key in anim.animators) {
    const animator = anim.animators[key];
    if (params.bone) {
      if (key === 'effects') continue;
      const boneName = animator.name || '';
      const wanted = String(params.bone).toLowerCase();
      if (key !== params.bone && boneName.toLowerCase() !== wanted) continue;
    }
    for (const kf of animator.keyframes) {
      if (params.channel && kf.channel !== params.channel) continue;
      if (kf.time < range[0] - 1e-6 || kf.time > range[1] + 1e-6) continue;
      targets.push(kf);
    }
  }
  if (!targets.length) {
    fail(`No keyframes matched (bone: ${params.bone ?? 'any'}, channel: ${params.channel ?? 'any'}, time_range: ${JSON.stringify(params.time_range) ?? 'all'}). Use get_animation to inspect keyframes.`);
  }
  Undo.initEdit({ animations: [anim] });
  const snap = params.snap !== false;
  let deleted = 0;
  const moved: { bone: string; channel: string; requested: number; time: number }[] = [];
  const retime = (kf: any, requested: number) => {
    const time = placeTime(requested, anim, snap);
    if (Math.abs(time - requested) > 1e-9) {
      moved.push({ bone: kf.animator?.name || '?', channel: kf.channel, requested, time });
    }
    kf.time = time;
  };
  for (const kf of targets) {
    if (params.delete === true) { kf.remove(); deleted++; continue; }
    if (params.set_time != null) retime(kf, params.set_time);
    if (params.time_offset != null) retime(kf, kf.time + params.time_offset);
    if (params.time_scale != null) retime(kf, kf.time * params.time_scale);
    if (params.set_interpolation) kf.interpolation = params.set_interpolation;
    if (params.set_values) {
      const vals = normalizeValues(params.set_values, kf.channel);
      kf.set('x', vals.x); kf.set('y', vals.y); kf.set('z', vals.z);
    }
    if (params.value_multiplier != null) {
      for (const axis of ['x', 'y', 'z']) {
        const current = kf.calc(axis);
        kf.set(axis, Math.round(current * params.value_multiplier * 10000) / 10000);
      }
    }
  }
  // Deleting or pulling keyframes inward should be able to SHRINK the clip;
  // the plain max() below can only ever grow it, which left retimed animations
  // stuck at their old length with no way back.
  if (params.resize_to_content === true) anim.setLength(contentLength(anim));
  else anim.setLength(Math.max(anim.length, anim.getMaxLength()));
  Undo.finishEdit('MCP: Edit keyframes', { animations: [anim] });
  Animator.preview();
  return {
    affected: targets.length,
    deleted: deleted || undefined,
    animation: anim.name,
    length: anim.length,
    content_length: Math.round(contentLength(anim) * 100000) / 100000,
    snapped: snapReport(moved, anim),
  };
});

register('add_effect_keyframes', (params) => {
  requireAnimationSupport();
  const anim = resolveAnimation(params.animation);
  if (!Array.isArray(params.effects) || !params.effects.length) {
    fail('Pass "effects": [{channel: particle|sound|timeline, time, effect?, locator?, file?, script?}]');
  }
  Undo.initEdit({ animations: [anim] });
  if (!anim.animators.effects) anim.animators.effects = new EffectAnimator(anim);
  const animator = anim.animators.effects;
  for (const def of params.effects) {
    if (!['particle', 'sound', 'timeline'].includes(def.channel)) fail(`Invalid effect channel "${def.channel}". Valid: particle, sound, timeline.`);
    const dp: any = {};
    if (def.effect) dp.effect = def.effect;
    if (def.locator) dp.locator = def.locator;
    if (def.file) dp.file = def.file;
    if (def.script) dp.script = def.script;
    animator.addKeyframe({
      channel: def.channel,
      time: Timeline.snapTime(def.time ?? 0, anim),
      data_points: [dp],
    });
  }
  animator.addToTimeline();
  anim.setLength(Math.max(anim.length, anim.getMaxLength()));
  Undo.finishEdit('MCP: Add effect keyframes', { animations: [anim] });
  return { animation: anim.name, added: params.effects.length };
});

register('apply_animation_preset', (params) => {
  requireAnimationSupport();
  const presets = Animator.animation_presets;
  const preset = presets[params.preset];
  if (!preset) {
    fail(`Unknown preset "${params.preset}". Available presets: ${Object.keys(presets).join(', ')}`);
  }
  const anim = resolveAnimation(params.animation);
  const node = resolveAnimatableNode(params.bone);
  ensureAnimateMode();
  anim.select();
  const animator = anim.getBoneAnimator(node);
  animator.applyAnimationPreset(preset);
  anim.setLength(Math.max(anim.length, anim.getMaxLength()));
  Animator.preview();
  return { animation: anim.name, bone: node.name, preset: params.preset, length: anim.length };
});

register('preview_animation', async (params) => {
  requireAnimationSupport();
  const anim = resolveAnimation(params.animation);
  ensureAnimateMode();
  anim.select();
  const time = params.time ?? 0;
  Timeline.setTime(Math.max(0, time));
  Animator.preview();
  const result: any = { animation: anim.name, time, length: anim.length };
  if (params.screenshot !== false) {
    result.__image = await takeScreenshot({
      angle: params.angle,
      camera: params.camera,
      resolution: params.resolution,
    });
  }
  return result;
});

register('render_animation', async (params) => {
  requireAnimationSupport();
  const anim = resolveAnimation(params.animation);
  ensureAnimateMode();
  anim.select();
  let times: number[];
  if (Array.isArray(params.times) && params.times.length) {
    times = params.times.slice(0, 8);
  } else {
    const count = clampInt(params.frames ?? 4, 2, 8);
    const length = anim.length || anim.getMaxLength() || 1;
    times = Array.from({ length: count }, (_, i) => Math.round((i / (count - 1)) * length * 1000) / 1000);
  }
  const resolution = clampInt(params.resolution ?? 480, 128, 800);
  const images: string[] = [];
  for (const t of times) {
    Timeline.setTime(Math.max(0, t));
    Animator.preview();
    images.push(await takeScreenshot({ angle: params.angle, camera: params.camera, resolution }));
  }
  return {
    animation: anim.name,
    times,
    note: 'Frames are in chronological order.',
    __images: images,
  };
});
