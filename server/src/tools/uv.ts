// UV, unwrap, bake, palette, reference matching and build recording.
import { z } from 'zod';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forward } from '../respond';
import { vec3, vec2, readOnly, mutating, facesSchema, registerGroup } from './shared';

export function registerUvTools(server: McpServer) {
  registerGroup(server, 'uv', {
    title: 'Inspect and edit UV mapping',
    description: 'UV mapping of cubes and meshes. For a fresh paintable layout use generate_texture_template (cubes) or unwrap_mesh (meshes) instead.',
    annotations: mutating,
    actions: {
      inspect: {
        command: 'inspect_uv',
        description: 'Diagnose how the texture actually maps onto the model — the first thing to run when a texture "looks wrong on the model" but the texture image itself looks fine. Reports, per cube face: UV rotation, mirrored rects, rects whose aspect does not match the face (stretched or turned 90°), UV rects SHARED by several faces (painting one repaints all), faces with no texture, fully transparent pixels inside a face rect (they render see-through), atlas coverage, and the bitmap-to-UV-grid scale (how many bitmap pixels one UV unit is — needed for absolute paint coordinates). Meshes: degenerate (unpaintable) UV polygons, texels shared by several faces, transparent texels inside faces. Plus texel density (texture px per model unit) min/median/max across cubes and meshes, flagging faces >1.5x off the median. Returns a "findings" list with severities plus the raw counts. NOTE: mirroring on "up"/"down" faces is Blockbench\'s normal box unwrap, not a defect. Read-only.',
        inputSchema: {
          texture: z.string().optional().describe('inspect: limit the report to one texture (default: all)'),
          scan_pixels: z.boolean().optional().describe('inspect: scan each face rect for transparent pixels (default true; false = fast structural-only check on huge models)'),
          max_samples: z.number().optional().describe('inspect: example faces listed per problem type, default 6'),
        },
      },
      set_cube: {
        command: 'set_cube_uv',
        description: 'Batch-edit cube UV mapping: per-face UV rects/rotation/texture, or box-UV mode with uv_offset. UV units span the project (or texture) UV size, not raw pixels.',
        inputSchema: {
          cubes: z.array(z.object({
            id: z.string(),
            box_uv: z.boolean().optional().describe('Switch UV mode'),
            uv_offset: vec2().optional().describe('Box UV unwrap position'),
            mirror_uv: z.boolean().optional(),
            faces: facesSchema.optional(),
          })).min(1),
        },
      },
      set_mesh: {
        command: 'set_mesh_uv',
        description: 'Set per-vertex UV coordinates of mesh faces. Get face/vertex keys from get_element.',
        inputSchema: {
          mesh: z.string(),
          faces: z.record(z.string(), z.record(z.string(), vec2())).describe('set_mesh: {face_key: {vertex_key: [u, v]}}'),
        },
      },
      auto: {
        command: 'auto_uv',
        description: 'Automatically size face UVs to match element dimensions (cubes) / auto-project (meshes).',
        inputSchema: { elements: z.array(z.string()).optional().describe('auto: default all') },
      },
    },
  });

  server.registerTool('unwrap_mesh', {
    title: 'Unwrap meshes into UV islands',
    description: 'UV-unwrap cubes and meshes onto a NEW packed texture, the way a low-poly character is prepared for hand painting. Unlike generate_texture_template, connected mesh faces are joined into islands (a limb becomes one strip instead of dozens of loose faces), so painting runs continuously across them.\n- seams: cut ("divide") or force-join ("join") specific mesh edges before unwrapping — e.g. cut a sleeve along its inner side. "auto" clears a seam.\n- seam_angle / island_angle: faces only join across edges flatter than seam_angle, and an island stops growing once it bends more than island_angle in total (defaults 36 / 45).\n- density_scale: more or fewer texels for chosen parts, e.g. {"head": 2, "boots": 0.5} — give the face and torso extra detail.\n- keep_paint (default true): texels already painted on the old UVs are copied to the new layout face by face, so you can re-unwrap after modeling changes without losing paint.\nReports texel density (texture px per model unit) min/median/max. Then paint with paint_texture/paint_faces targets or bake_texture.',
    inputSchema: {
      elements: z.array(z.string()).optional().describe('Cubes/meshes/groups to unwrap (default: the whole model)'),
      pixel_density: z.number().optional().describe('Template resolution, 1-512: 16 = 1 texture px per model unit, 32 = 2 px, 64 = 4 px (default 16). Low-poly painted characters usually want 32-64.'),
      density_scale: z.record(z.string(), z.number()).optional().describe('Per element/group multiplier on the density, e.g. {"head": 2}'),
      seams: z.array(z.object({
        mesh: z.string().describe('Mesh name/uuid'),
        edges: z.array(z.array(z.string()).length(2)).describe('[[vertexA, vertexB], ...] vertex keys from get_element'),
        mode: z.enum(['divide', 'join', 'auto']).optional().describe('divide (default) = cut here; join = never cut here; auto = clear'),
      })).optional(),
      seam_angle: z.number().optional().describe('Max angle (deg) between faces that may share an island, default 36'),
      island_angle: z.number().optional().describe('Max total bend (deg) inside one island, default 45'),
      combine: z.boolean().optional().describe('Join connected mesh faces into islands (default true)'),
      keep_paint: z.boolean().optional().describe('Copy existing paint to the new layout (default true)'),
      padding: z.boolean().optional().describe('1px gap between islands (default true — stops colors bleeding at seams)'),
      power_of_two: z.boolean().optional().describe('Round the texture size up to a power of two (default true)'),
      color: z.string().optional().describe('Template background color'),
      name: z.string().optional().describe('New texture name'),
    },
    annotations: mutating,
  }, forward('unwrap_mesh'));

  server.registerTool('bake_texture', {
    title: 'Bake hand-painted shading into the texture',
    description: 'Paint lighting into the texture the way hand-painted low-poly / PS1 characters are shaded — no runtime lights needed. Works on cubes and meshes (any UV layout). Each pass contributes SHADE STEPS per texel; the sum is snapped to whole steps of a hue-shifting pixel-art ramp built from each texel\'s own flat colour (shadows darker + cooler + a bit more saturated, highlights lighter + warmer), so the result reads as deliberate pixel-art bands, not airbrush.\nPasses (default light + ao + edges):\n- light {direction: [x,y,z] TOWARD the light (default [0.5,1,-0.7]: above, front-left), shadow: steps at the dark side (1.5), highlight: steps facing the light (1), wrap 0-1 (0.3), midpoint 0-1 (0.5) where shading turns from shadow to highlight, full 0-1 (0.85) where the highlight is complete} — per-face normals give the faceted low-poly look.\n- ao {distance units (6), samples (24), strength: steps of darkening in a 90° corner (1.5)} — ray-traced ambient occlusion against the WHOLE model: armpits, under the hat brim, between fingers, where the coat meets the trousers.\n- edges {width px (1), highlight (1) on convex edges, cavity (1) on concave creases, boundary (1) on open edges like a cape hem, angle (25° — flatter edges are ignored)} — the light rim on edges and dark crease lines.\n- gradient {bottom (-1), top (0), range?: [y0, y1]} — darker toward the feet.\n- noise {amount (0.3), scale px (1), seed} — painterly grain that breaks up bands.\nWORKFLOW: paint flat base colours (paint_faces / paint_texture), then bake into a separate "layer" (e.g. "shading"): shading is then read from the bottom layer\'s flat colours, so you can tweak and re-bake without compounding. Without "layer" it overwrites the base image.',
    inputSchema: {
      elements: z.array(z.string()).optional().describe('Cubes/meshes/groups to bake (default whole model)'),
      texture: z.string().optional().describe('Only faces using this texture'),
      layer: z.string().optional().describe('Write into this texture layer (created if missing). Recommended: "shading".'),
      source: z.string().optional().describe('Layer holding the flat colours (default: the bottom layer when "layer" is set, else the composite)'),
      passes: z.array(z.object({
        type: z.enum(['light', 'ao', 'edges', 'gradient', 'noise']),
        direction: vec3().optional(),
        shadow: z.number().optional(), highlight: z.number().optional(), wrap: z.number().optional(), midpoint: z.number().optional(), full: z.number().optional(),
        distance: z.number().optional(), samples: z.number().optional(), strength: z.number().optional(),
        width: z.number().optional(), cavity: z.number().optional(), boundary: z.number().optional(), angle: z.number().optional(),
        bottom: z.number().optional(), top: z.number().optional(), range: vec2().optional(),
        amount: z.number().optional(), scale: z.number().optional(), seed: z.number().optional(),
      })).optional(),
      max_shadow: z.number().optional().describe('Darkest step (default 3)'),
      max_highlight: z.number().optional().describe('Brightest step (default 2)'),
      dither: z.enum(['none', 'bayer2', 'bayer4', 'bayer8']).optional().describe('Ordered dither at band transitions (default none)'),
      ramp: z.object({
        step: z.number().optional().describe('Oklab lightness per step (0.13)'),
        hue_shift: z.number().optional().describe('Degrees of hue shift per step (15)'),
        shadow_hue: z.number().optional().describe('Hue shadows drift toward (270 = blue-violet)'),
        highlight_hue: z.number().optional().describe('Hue highlights drift toward (90 = warm yellow)'),
      }).optional(),
      only_painted: z.boolean().optional().describe('Skip transparent texels (default true)'),
    },
    annotations: mutating,
  }, forward('bake_texture'));

  server.registerTool('palette', {
    title: 'Colour ramps & palette lock',
    description: 'Colour discipline for pixel-art textures.\n- ramp {colors: ["#base", ...], shadows (2), highlights (2), ramp?}: build a hue-shifting ramp per base colour (shadows darker + cooler + slightly more saturated, highlights lighter + warmer + less saturated). Returns the hexes and a swatch image — pick flat colours and accents from these so the whole character shares one coherent palette.\n- extract {texture, max_colors?}: unique colour count, most used colours, and a reduced palette.\n- quantize {texture, palette, layer?, dither?}: snap every pixel to a palette — "auto" (median cut to max_colors, default 24), "ramps" (ramps from "colors"), a built-in (pico8, sweetie16, endesga32, db32, aap64, resurrect64, apollo) or an array of hexes. Run it last to clean up stray colours from painting/baking/projection. With texture layers it works on the given (or active) layer.',
    inputSchema: {
      action: z.enum(['ramp', 'extract', 'quantize']),
      colors: z.array(z.string()).optional().describe('ramp / quantize "ramps": base colours'),
      color: z.string().optional(),
      shadows: z.number().optional().describe('Shadow steps per ramp'),
      highlights: z.number().optional().describe('Highlight steps per ramp'),
      ramp: z.object({
        step: z.number().optional(), hue_shift: z.number().optional(), shadow_hue: z.number().optional(), highlight_hue: z.number().optional(),
      }).optional(),
      texture: z.string().optional(),
      layer: z.string().optional(),
      palette: z.union([z.string(), z.array(z.string())]).optional().describe('quantize target: "auto", "ramps", a built-in name, or hex colours'),
      max_colors: z.number().optional(),
      dither: z.enum(['none', 'bayer2', 'bayer4', 'bayer8']).optional(),
      dither_strength: z.number().optional().describe('0-1, default 0.5'),
      binary_alpha: z.boolean().optional().describe('quantize: snap alpha to 0/255 (default true)'),
    },
    annotations: mutating,
  }, forward('palette'));

  const refCamera = {
    image: z.string().optional().describe('Absolute path to the reference picture (png/jpg/webp)'),
    image_data: z.string().optional().describe('Or the image as base64 / data URL'),
    view: z.string().optional().describe('Camera preset matching the reference (front, back, side, left, three_quarter, isometric...) — default front'),
    yaw: z.number().optional().describe('Override: degrees around Y (0 = front, 90 = right side, 180 = back); a 3/4 portrait is often 20-35'),
    pitch: z.number().optional().describe('Override: degrees of downward tilt'),
    background: z.string().optional().describe('Reference background colour when the image has no transparency (default: sampled from its corners)'),
    tolerance: z.number().optional().describe('Background colour tolerance per channel (default 40)'),
    resolution: z.number().optional().describe('Model render size in px'),
  };

  server.registerTool('compare_reference', {
    title: 'Compare the model to a reference image',
    description: 'Score how well the model\'s SILHOUETTE matches a reference picture from the same angle, and say where it differs. The model is rendered from view/yaw/pitch, fitted to the reference silhouette by height and centred, then compared: IoU (1 = identical, >0.85 close), aspect ratios, and per height band (top → bottom) the model vs reference width and centre shift, with plain advice like "40-50% from top: model is 22% NARROWER (~3 units)". Returns an image: reference | fitted model | overlay (RED = model has too much, BLUE = missing). Use it in a loop: compare → adjust (transform_mesh / update_elements / add_loft) → compare again. Matching the camera angle matters more than anything — try a few yaw values if the reference is a 3/4 view.',
    inputSchema: {
      ...refCamera,
      bands: z.number().optional().describe('Height bands to report (default 8)'),
      threshold: z.number().optional().describe('Width difference % that triggers advice (default 12)'),
    },
    annotations: readOnly,
  }, forward('compare_reference'));

  server.registerTool('project_reference', {
    title: 'Project a reference image onto the texture',
    description: 'Paint the reference picture onto the model through the same fitted camera as compare_reference — a fast, faithful starting point for the texture (colours, patterns, buttons, trim in the right places). Only texels that face the camera and are not hidden behind other parts are painted; run it again from other views (back/side) with matching pictures, or paint the rest by hand. Fix proportions first (compare_reference), unwrap first (unwrap_mesh), paint into a "layer" to keep it separate, then palette {action:"quantize"} to snap to a tight palette and bake_texture for lighting.',
    inputSchema: {
      ...refCamera,
      elements: z.array(z.string()).optional().describe('Limit to these cubes/meshes/groups (default whole model)'),
      layer: z.string().optional().describe('Paint into this texture layer (created if missing)'),
      opacity: z.number().optional().describe('0-1, default 1'),
      min_facing: z.number().optional().describe('Skip faces whose normal·view is below this (default 0.15) — steep faces smear'),
    },
    annotations: mutating,
  }, forward('project_reference'));

  server.registerTool('record_build', {
    title: 'Record a build timelapse (GIF)',
    description: 'Record the model being built, part by part, like the turnaround/timelapse GIFs artists post. "start" fixes a camera and scale; from then on every finished edit (each undo step) captures a frame — the model grows in place. "frame" captures one manually, "status" reports, "stop" writes an animated GIF to "path" (fps, hold_last seconds on the final frame) and returns a contact sheet; "cancel" discards. Frames that look identical to the previous one are skipped.',
    inputSchema: {
      action: z.enum(['start', 'frame', 'status', 'stop', 'cancel']),
      view: z.string().optional().describe('start: camera preset (default three_quarter)'),
      yaw: z.number().optional(), pitch: z.number().optional(),
      size: z.number().optional().describe('start: frame size in px (default 256)'),
      height_units: z.number().optional().describe('start: model units that fit the frame height (default 48) — set to the finished model\'s height'),
      background: z.string().optional().describe('start: solid background colour (default transparent)'),
      label: z.string().optional().describe('frame: label'),
      path: z.string().optional().describe('stop: absolute .gif path to write'),
      fps: z.number().optional().describe('stop: frames per second (default 6)'),
      hold_last: z.number().optional().describe('stop: seconds to hold the final frame (default 2)'),
    },
    annotations: mutating,
  }, forward('record_build'));
}
