// Animations and keyframes.
import { z } from 'zod';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forward } from '../respond';
import { vec3, vec2, molangValue, readOnly, mutating, destructive, cameraSchema, anglePresets } from './shared';

export function registerAnimationTools(server: McpServer) {
  server.registerTool('create_animation', {
    title: 'Create animation',
    description: 'Create an animation. Blockbench animates GROUPS (bones): rotation/position/scale channels per bone. Works for rigged models (deep bone hierarchies) and simple group-based models alike — any cube you want to move must be inside a group. After creating, add keyframes with set_keyframes. Bedrock naming convention: "animation.<model>.<action>".',
    inputSchema: {
      name: z.string(),
      loop: z.enum(['once', 'loop', 'hold']).optional().describe('default "once"; "loop" repeats, "hold" freezes on last frame'),
      length: z.number().optional().describe('Seconds; auto-extends to the last keyframe'),
      snapping: z.number().optional().describe('Keyframe FPS grid, default 24'),
      override: z.boolean().optional().describe('Override lower animation layers (bedrock)'),
      anim_time_update: z.string().optional().describe('Molang'),
      blend_weight: z.string().optional().describe('Molang'),
      start_delay: z.string().optional(),
      loop_delay: z.string().optional(),
    },
    annotations: mutating,
  }, forward('create_animation'));

  server.registerTool('list_animations', {
    title: 'List animations',
    description: 'List all animations with lengths and per-bone keyframe counts.',
    inputSchema: {},
    annotations: readOnly,
  }, forward('list_animations'));

  server.registerTool('get_animation', {
    title: 'Get animation details',
    description: 'Full keyframe dump of one animation: every bone, channel, keyframe time/values/interpolation.',
    inputSchema: { id: z.string().optional().describe('Name or uuid (default: selected)') },
    annotations: readOnly,
  }, forward('get_animation'));

  server.registerTool('update_animation', {
    title: 'Update animation properties',
    description: 'Change animation name, loop mode, length, snapping, Molang properties. Setting a SHORTER "length" is honoured — any keyframes left beyond the new end are listed in the result\'s "warning" so you can move them with edit_keyframes or delete them. Raising "snapping" (the FPS grid) makes your intended keyframe times land exactly: 0.3s needs a multiple of 10 fps, not the default 24.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      loop: z.enum(['once', 'loop', 'hold']).optional(),
      length: z.number().optional().describe('Clip length in seconds. Shorter values are applied (keyframes past the end stop playing but are kept).'),
      snapping: z.number().optional().describe('Keyframe FPS grid, default 24'),
      override: z.boolean().optional(),
      anim_time_update: z.string().optional(),
      blend_weight: z.string().optional(),
    },
    annotations: mutating,
  }, forward('update_animation'));

  server.registerTool('delete_animation', {
    title: 'Delete animation',
    description: 'Delete an animation (undoable).',
    inputSchema: { id: z.string() },
    annotations: destructive,
  }, forward('delete_animation'));

  server.registerTool('set_keyframes', {
    title: 'Set keyframes',
    description: 'The main animation tool: batch-create keyframes for multiple bones/channels in one call. Channels: "rotation" (degrees), "position" (units), "scale" (multiplier). "values" is [x,y,z] — numbers or MOLANG strings (e.g. "math.sin(query.anim_time*360)*15" for procedural motion). ROTATION SIGNS (Euler ZYX around the bone pivot): +X swings a hanging limb FORWARD (toward -Z/north, the way entities face), -X backward; +Y yaws CCW from above; +Z rolls the top toward west. Interpolation: linear, catmullrom (smooth), bezier (custom handles), step (instant). Keyframes at an existing time replace it; "replace": true clears the whole channel first.\n\nREST POSE IS ADDITIVE: if the bone was modelled with a non-zero rest rotation, keyframe values are OFFSETS from it, not absolute angles — a bone resting at [0,90,0] keyframed to [0,0,0] still points at 90°. The result reports each targeted bone\'s rest rotation when it is non-zero.\n\nTIMING: times snap to the animation FPS grid ("snapping", default 24), so 0.3s becomes 0.29167s and 1.2s becomes 1.20833s — which can push your last keyframe past the intended length. Every moved time is reported back under "snapped". Pass "snap": false (per call, per bone, or per keyframe) to write exact times instead. Retime or delete existing keyframes with edit_keyframes.\n\nExample walk cycle: leg rotation [{time:0, values:[-30,0,0]}, {time:0.25, values:[30,0,0]}, {time:0.5, values:[-30,0,0]}] with loop:"loop" — then mirror_keyframes copies it to the opposite leg with phase_offset.',
    inputSchema: {
      animation: z.string().optional().describe('Name/uuid (default: selected)'),
      snap: z.boolean().optional().describe('false = write exact times, skipping the FPS-grid quantisation (default true). Overridable per bone and per keyframe.'),
      bones: z.array(z.object({
        bone: z.string().describe('Group (bone) name or uuid'),
        channel: z.enum(['rotation', 'position', 'scale']),
        replace: z.boolean().optional().describe('Clear existing keyframes on this channel first'),
        snap: z.boolean().optional().describe('Per-bone override of the FPS-grid snapping'),
        keyframes: z.array(z.object({
          time: z.number().describe('Seconds'),
          snap: z.boolean().optional().describe('Per-keyframe override of the FPS-grid snapping'),
          values: z.union([z.array(molangValue()).length(3), molangValue()]).optional().describe('[x,y,z] or single value for all axes. Molang strings allowed.'),
          post_values: z.union([z.array(molangValue()).length(3), molangValue()]).optional().describe('Second data point → instant jump (pre/post) keyframe'),
          interpolation: z.enum(['linear', 'catmullrom', 'bezier', 'step']).optional(),
          uniform: z.boolean().optional().describe('Scale channel: lock axes together'),
          bezier: z.object({
            left_time: vec3().optional(), left_value: vec3().optional(),
            right_time: vec3().optional(), right_value: vec3().optional(),
            linked: z.boolean().optional(),
          }).optional(),
        })).min(1),
      })).min(1),
    },
    annotations: mutating,
  }, forward('set_keyframes'));

  server.registerTool('edit_keyframes', {
    title: 'Move / retime / delete keyframes',
    description: 'THE retime and delete tool for keyframes that already exist. Select them by bone, channel and/or time_range, then: move them to an exact time (set_time), shift them (time_offset), stretch or compress the whole clip (time_scale), snap them off the FPS grid ("snap": false — how you fix a keyframe that landed on 1.20833s instead of 1.2s), change interpolation, set or scale values, or delete them (delete: true).\n\nUse "resize_to_content": true to shrink the animation length back down to the last remaining keyframe — without it the length only ever grows. The result reports both the clip length and the content length.',
    inputSchema: {
      animation: z.string().optional(),
      bone: z.string().optional().describe('Filter by bone name'),
      channel: z.enum(['rotation', 'position', 'scale', 'particle', 'sound', 'timeline']).optional(),
      time_range: z.array(z.number()).length(2).optional().describe('[start, end] seconds inclusive'),
      delete: z.boolean().optional(),
      set_time: z.number().optional().describe('Move every matched keyframe to this absolute time in seconds (applied before time_offset/time_scale)'),
      time_offset: z.number().optional().describe('Shift matched keyframes by this many seconds'),
      time_scale: z.number().optional().describe('Multiply matched keyframe times (retime the clip)'),
      snap: z.boolean().optional().describe('false = write exact times instead of quantising to the animation FPS grid (default true)'),
      resize_to_content: z.boolean().optional().describe('Set the animation length to the last keyframe — the only way to SHORTEN a clip after deleting or pulling keyframes in'),
      set_interpolation: z.enum(['linear', 'catmullrom', 'bezier', 'step']).optional(),
      set_values: z.union([z.array(molangValue()).length(3), molangValue()]).optional(),
      value_multiplier: z.number().optional().describe('Multiply numeric keyframe values (intensity)'),
    },
    annotations: destructive,
  }, forward('edit_keyframes'));

  server.registerTool('mirror_keyframes', {
    title: 'Mirror keyframes (left↔right bones)',
    description: 'Copy keyframes from one bone to its opposite-side partner with X-symmetry value mirroring (rotation [x,-y,-z], position [-x,y,z], scale unchanged; Molang strings are negated as -(expr)). "phase_offset" shifts the copy in time, wrapping around the animation length — THE walk-cycle tool: author the left leg, then mirror to the right leg with phase_offset = half the cycle. Without "mappings", bones are auto-paired by left/right name tokens (only into empty targets). Bezier handles and step/catmullrom interpolation are preserved.',
    inputSchema: {
      animation: z.string().optional().describe('Name/uuid (default: selected)'),
      mappings: z.array(z.object({
        from: z.string().describe('Source bone name/uuid'),
        to: z.string().describe('Target bone name/uuid'),
        phase_offset: z.number().optional().describe('Per-mapping time shift in seconds'),
      })).optional().describe('Explicit bone pairs; omit to auto-pair left/right bones'),
      phase_offset: z.number().optional().describe('Time shift in seconds for all mappings (e.g. 0.25 for a 0.5s walk cycle)'),
      channels: z.array(z.enum(['rotation', 'position', 'scale'])).optional().describe('Default: all three'),
      mirror_values: z.boolean().optional().describe('false = copy values verbatim (no sign flips)'),
      replace: z.boolean().optional().describe('Clear target channels first, default true'),
      wrap: z.boolean().optional().describe('Wrap shifted times around the animation length, default true'),
    },
    annotations: mutating,
  }, forward('mirror_keyframes'));

  server.registerTool('add_effect_keyframes', {
    title: 'Add effect keyframes',
    description: 'Add particle / sound / timeline-script keyframes to an animation (bedrock effect channels).',
    inputSchema: {
      animation: z.string().optional(),
      effects: z.array(z.object({
        channel: z.enum(['particle', 'sound', 'timeline']),
        time: z.number(),
        effect: z.string().optional().describe('Particle/sound effect id, e.g. "minecraft:campfire_smoke"'),
        locator: z.string().optional(),
        file: z.string().optional().describe('Local particle/sound file for preview. Since Blockbench 5.2 a relative path resolves against the saved .bbmodel\'s folder.'),
        script: z.string().optional().describe('Molang script (particle pre-effect / timeline)'),
      })).min(1),
    },
    annotations: mutating,
  }, forward('add_effect_keyframes'));

  server.registerTool('apply_animation_preset', {
    title: 'Apply animation preset',
    description: 'Apply a built-in Blockbench motion preset to a bone: float, flap, swing, strike, scale_in, scale_out, drop_down, impact, shiver, sway, shake, jump, swell, circle, open_door, close_door, look_at_target, rotate_to_camera, flicker, hide. Quick canned motion — inspect with get_animation afterwards.',
    inputSchema: {
      animation: z.string().optional(),
      bone: z.string(),
      preset: z.string(),
    },
    annotations: mutating,
  }, forward('apply_animation_preset'));

  server.registerTool('variable_placeholders', {
    title: 'Molang variable placeholders',
    description: 'Give Molang variables a preview value so animations that read them (variable.attack_time, query.is_sneaking, query.modified_move_speed...) actually move in preview_animation / render_animation instead of evaluating to 0. Edits the Variable Placeholders panel: "add" writes lines of the four kinds Blockbench 5.2\'s Create Variable Placeholder tool knows — value (fixed number/Molang), slider (adjustable number with step/range), toggle (0/1), impulse (briefly 1). "values" then sets sliders/toggles by name. "text" replaces the whole panel. Without params it just reports the current state.',
    inputSchema: {
      text: z.string().optional().describe('Replace the entire placeholder text (one "variable.x = value" per line)'),
      add: z.array(z.object({
        variable: z.string().describe('e.g. "variable.attack_time" or "query.is_sneaking"'),
        type: z.enum(['value', 'slider', 'toggle', 'impulse']).optional().describe('default "value"'),
        value: z.union([z.number(), z.string()]).optional().describe('type "value": number or Molang expression'),
        name: z.string().optional().describe('slider/toggle/impulse button name (default: the variable name)'),
        step: z.number().optional().describe('slider step'),
        range: vec2().optional().describe('slider [min, max]'),
        duration: z.number().optional().describe('impulse length in seconds'),
      })).optional().describe('Placeholders to add (an existing line for the same variable is replaced)'),
      values: z.record(z.string(), z.number()).optional().describe('Set slider/toggle buttons by name, e.g. {"attack_time": 0.5}'),
    },
    annotations: mutating,
  }, forward('variable_placeholders'));

  server.registerTool('preview_animation', {
    title: 'Preview animation at time',
    description: 'Pose the model at a given animation time and return a screenshot — your main feedback loop while animating.',
    inputSchema: {
      animation: z.string().optional(),
      time: z.number().describe('Seconds'),
      angle: z.string().optional().describe(`Angle preset: ${anglePresets}`),
      camera: cameraSchema.optional(),
      resolution: z.number().optional(),
    },
    annotations: readOnly,
  }, forward('preview_animation', 60_000));

  server.registerTool('render_animation', {
    title: 'Render animation frames',
    description: 'Render 2-8 frames of an animation as images (chronological). Use to verify motion arcs at a glance.',
    inputSchema: {
      animation: z.string().optional(),
      frames: z.number().optional().describe('Evenly spaced frame count, default 4, max 8'),
      times: z.array(z.number()).optional().describe('Explicit times (overrides frames)'),
      angle: z.string().optional(),
      camera: cameraSchema.optional(),
      resolution: z.number().optional().describe('Per-frame size, default 480'),
    },
    annotations: readOnly,
  }, forward('render_animation', 120_000));
}
