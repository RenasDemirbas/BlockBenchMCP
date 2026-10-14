// Textures and painting.
import { z } from 'zod';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forward } from '../respond';
import { vec2, readOnly, mutating, destructive, anyFace, layerBlendModes, layerParam } from './shared';

export function registerTextureTools(server: McpServer) {
  server.registerTool('create_texture', {
    title: 'Create texture',
    description: 'Create a texture: blank, solid color, or from base64 PNG data. In bedrock formats one texture is shared by the whole model. WARNING: without "fill_color" or "data" the texture is FULLY TRANSPARENT — applying it makes the model render invisible (blank screenshots); the result reports visible_pixels and warns when that happens. TIP: for a fresh model, generate_texture_template is usually better — it lays out all element UVs automatically.',
    inputSchema: {
      name: z.string(),
      width: z.number().optional().describe('Pixels, default = project texture width'),
      height: z.number().optional(),
      fill_color: z.string().optional().describe('CSS color, e.g. "#8B4513" or "rgba(120,80,40,1)"'),
      data: z.string().optional().describe('Base64 PNG (with or without data: prefix)'),
      pbr_channel: z.enum(['color', 'normal', 'height', 'mer']).optional(),
      render_mode: z.enum(['default', 'emissive', 'additive', 'layered']).optional(),
      particle: z.boolean().optional().describe('Use as particle texture (bedrock)'),
      force_translucent: z.boolean().optional().describe('Java block/item: export as translucent ({"sprite", "force_translucent": true} in the model JSON). Blockbench 5.2.2+'),
      apply_to_all: z.boolean().optional().describe('Apply to all elements after creating'),
    },
    annotations: mutating,
  }, forward('create_texture'));

  server.registerTool('generate_texture_template', {
    title: 'Generate texture template',
    description: 'Auto-generate a texture with all element UVs laid out (like Blockbench "Create Template"). Re-arranges element UVs onto the new texture — do this AFTER modeling, BEFORE painting. Then use paint_texture with face targets.',
    inputSchema: {
      name: z.string().optional(),
      pixel_density: z.number().optional().describe('Texture pixels per model unit x16, 1-512. 16 = 1px per unit (default), 32 = 2px per unit'),
      elements: z.array(z.string()).optional().describe('Limit to these elements (default: all)'),
      rearrange_uv: z.boolean().optional().describe('default true'),
      power_of_two: z.boolean().optional().describe('Round texture size up to power of two (default true)'),
      padding: z.boolean().optional(),
      color: z.string().optional().describe('Base fill color'),
    },
    annotations: mutating,
  }, forward('generate_texture_template', 45_000));

  server.registerTool('list_textures', {
    title: 'List textures',
    description: 'List all textures with sizes, UV sizes and flags.',
    inputSchema: {},
    annotations: readOnly,
  }, forward('list_textures'));

  server.registerTool('delete_texture', {
    title: 'Delete texture',
    description: 'Remove a texture from the project (undoable). In single-texture formats the remaining first texture becomes the model texture again.',
    inputSchema: { id: z.string().describe('Texture name/uuid') },
    annotations: destructive,
  }, forward('delete_texture'));

  server.registerTool('get_texture', {
    title: 'View texture (whole atlas or one face)',
    description: 'Return the texture image (PNG) so you can see it. Pixel-art textures are upscaled crisply.\n\nZOOM IN: pass "element" (cube, GROUP, or "*" for the whole model) to crop the atlas to just that element\'s UV region and scale it UP to max_size — the way to actually read one face\'s pixels instead of squinting at a 256x256 atlas. Add "face" for a single face ("north"/"up"/...) or "faces" for several, and "padding" to include surrounding UV context. The result reports the pixel region and each matched face\'s rect, so you know what you are looking at. If the selected faces span several textures it says so — pass "id" to pick one.',
    inputSchema: {
      id: z.string().optional().describe('Texture name/uuid (default: selected, or the texture the cropped faces use)'),
      max_size: z.number().optional().describe('Max returned dimension in px, default 512. A crop is scaled UP to fill it.'),
      element: z.string().optional().describe('Crop to this cube/mesh/group\'s UV region ("*" = every cube and mesh in the model)'),
      face: anyFace().optional().describe('Crop to one face of that element'),
      faces: z.union([z.array(anyFace()), z.literal('all')]).optional().describe('Crop to several faces (default: all faces of the element)'),
      padding: z.number().optional().describe('Extra UV units around the crop, default 0 — use 1-2 to see neighbouring pixels'),
      layer: z.string().optional().describe('Show only this texture layer (name/uuid) instead of the composite'),
    },
    annotations: readOnly,
  }, forward('get_texture'));

  server.registerTool('texture_layers', {
    title: 'Texture layers & layer groups',
    description: 'List and edit a texture\'s layers — Photoshop-style stacking with opacity, blend modes and (Blockbench 5.2) layer GROUPS. Without "ops" it just lists the layers (bottom → top). Ops run in order, as one undo step:\n- enable: turn layers on (the current image becomes the base layer)\n- add_layer {name, parent?, above?/below?, fill_color?, opacity?, blend_mode?, visible?}\n- add_group {name, parent?, layers?: [names to move in]} (5.2+)\n- update {layer, name?, opacity?, blend_mode?, visible?, parent? ("root" to take out of a group), offset?, above?/below?} — works on groups too (visibility/name/parent)\n- delete {layer} — a group takes its contents with it\n- merge_down {layer}, ungroup {layer} (5.2+), select {layer} (the active layer Blockbench\'s brushes use)\n- disable: flatten everything into one image\nOpacity is 0-1. Paint into a layer with paint_texture / paint_faces "layer"; view one with get_texture "layer".',
    inputSchema: {
      texture: z.string().optional().describe('Texture name/uuid (default: selected)'),
      ops: z.array(z.object({
        op: z.enum(['enable', 'disable', 'add_layer', 'add_group', 'update', 'delete', 'merge_down', 'ungroup', 'select']),
        layer: z.string().optional().describe('Target layer/group name or uuid (update/delete/merge_down/ungroup/select)'),
        name: z.string().optional().describe('Name for add_layer/add_group, or the new name for update'),
        parent: z.string().nullable().optional().describe('Layer group to place the item in ("root"/null = top level)'),
        above: z.string().optional().describe('Place directly above this layer'),
        below: z.string().optional().describe('Place directly below this layer'),
        opacity: z.number().optional().describe('0-1'),
        blend_mode: z.enum(layerBlendModes).optional(),
        visible: z.boolean().optional(),
        fill_color: z.string().optional().describe('add_layer: fill the new layer with this CSS color (default transparent)'),
        offset: vec2().optional().describe('update: layer position on the texture in pixels'),
        layers: z.array(z.string()).optional().describe('add_group: layers to move into the new group'),
      })).optional(),
    },
    annotations: mutating,
  }, forward('texture_layers'));

  server.registerTool('import_texture', {
    title: 'Import texture file',
    description: 'Import an image file from disk as a texture.',
    inputSchema: {
      path: z.string().describe('Absolute path to png/jpeg/webp/tga'),
      force_translucent: z.boolean().optional().describe('Java block/item: export as translucent ({"sprite", "force_translucent": true} in the model JSON). Blockbench 5.2.2+'),
    },
    annotations: mutating,
  }, forward('import_texture'));

  server.registerTool('apply_texture', {
    title: 'Apply texture',
    description: 'Assign a texture to element faces. Without "elements": applies to all elements (mode "blank" = only untextured faces).',
    inputSchema: {
      texture: z.string().describe('Texture name/uuid'),
      elements: z.array(z.string()).optional().describe('Element/group ids (groups apply recursively)'),
      mode: z.enum(['all', 'blank']).optional(),
    },
    annotations: mutating,
  }, forward('apply_texture'));

  server.registerTool('paint_texture', {
    title: 'Paint texture',
    description: 'Draw on a texture with declarative ops (batched in one call, one undo step). Pass "layer" to paint into a separate texture layer (created if missing). Op types: "pixel" {pixels: [[x,y],...]}, "line" {from, to, thickness?}, "rect" {from, to, filled?, thickness?}, "ellipse" {center, radius: [rx,ry], filled?}, "fill" (bucket) {at, tolerance?}, "gradient" (see "stops" and "space"), "clear" {from, to}, "jagged_edge" (pixel-art fur teeth along one rect edge — mode "erase" cuts the silhouette into transparency for fur planes, mode "color" draws colored teeth), "noise" (seeded speckle of color/color2; with no target and no from/to it covers the WHOLE bitmap), "strands" (seeded fur dashes whose count and length scale with the target rect, so one op reads right on a small paw and a big flank). Every op takes "color" (CSS string) and "opacity" (0-1).\n\nTARGETING: "target": {element, face} paints one cube face; "target": {element, faces: "all" | ["north",...]} paints many, and "element" may be a GROUP (recurses into every cube in it) — one op then expands to one op per face. Targeted ops use NORMALIZED 0-1 coordinates mapped onto each face\'s UV rect; untargeted ops use absolute BITMAP pixels.\n\nSHADING ACROSS CUBES: a face-local gradient restarts on every cube, which makes a limb built from several cubes look banded. Pass "space": "world" on a gradient (with a face target) to position the stops along the MODEL\'s Y extent instead, so neighbouring cubes continue the same ramp seamlessly. For plain solid faces prefer paint_faces. Verify with get_texture, uv action "inspect" or capture_screenshot.',
    inputSchema: {
      texture: z.string().optional().describe('Texture name/uuid (default: selected)'),
      layer: layerParam(),
      ops: z.array(z.object({
        type: z.enum(['pixel', 'line', 'rect', 'ellipse', 'fill', 'gradient', 'clear', 'jagged_edge', 'noise', 'strands']),
        color: z.string().optional(),
        color2: z.string().optional().describe('gradient end color / noise second color / strands highlight color'),
        opacity: z.number().optional(),
        from: vec2().optional(), to: vec2().optional(),
        at: vec2().optional(), center: vec2().optional(),
        radius: z.union([z.number(), vec2()]).optional(),
        pixels: z.array(vec2()).optional(),
        thickness: z.number().optional(),
        filled: z.boolean().optional().describe('rect/ellipse: false = outline. Default: filled, or outline when only "thickness" is given'),
        tolerance: z.number().optional().describe('fill: 0-100 color distance'),
        clip: z.object({ from: vec2(), to: vec2() }).optional(),
        stops: z.array(z.object({
          at: z.number().describe('0 = start of the sweep (top for a targeted face), 1 = end'),
          color: z.string(),
          opacity: z.number().optional().describe('Per-stop alpha — use 0 for a stop that fades out'),
        })).min(1).optional().describe('gradient: multi-stop ramp, replaces color/color2. A light stop at 0, a transparent stop mid-way and a dark stop at 1 gives top-lit volume in one op.'),
        space: z.enum(['face', 'world']).optional().describe('gradient: "face" (default) sweeps the face\'s own 0-1 box; "world" sweeps the model\'s Y extent so adjacent cubes share one continuous ramp (needs a face target)'),
        range: vec2().optional().describe('gradient + space "world": override the [minY, maxY] model range the stops map onto (default: the whole model)'),
        edge: z.enum(['top', 'bottom', 'left', 'right']).optional().describe('jagged_edge: which edge the teeth cut from, default top'),
        depth: z.number().optional().describe('jagged_edge: max tooth depth in px, default 40% of the rect'),
        min_depth: z.number().optional().describe('jagged_edge: min cut depth, default 0'),
        tooth_width: z.number().optional().describe('jagged_edge: px per tooth, default 2'),
        mode: z.enum(['erase', 'color']).optional().describe('jagged_edge: erase to transparency (default) or draw colored teeth'),
        density: z.number().optional().describe('noise: 0-1 fraction of pixels, default 0.15. strands: dashes per pixel of rect area, default 0.15'),
        direction: z.enum(['down', 'up', 'left', 'right']).optional().describe('strands: which way the fur lies, default down'),
        length: vec2().optional().describe('strands: [min, max] dash length as a FRACTION of the rect, default [0.1, 0.3]. Keep it short — long dashes read as wood grain, not fur.'),
        light_ratio: z.number().optional().describe('strands: fraction drawn in color2 as highlights, default 0.35'),
        opacity2: z.number().optional().describe('strands: opacity multiplier for the color2 highlights, default 0.6'),
        root: z.number().optional().describe('strands: darker band at the base, as a fraction of the rect, default 0 (off)'),
        root_color: z.string().optional().describe('strands: color of that root band, default the op color'),
        seed: z.number().optional().describe('jagged_edge/noise/strands: deterministic seed, default 1'),
        target: z.object({
          element: z.string().describe('Cube, MESH or GROUP name/uuid (a group recurses into all its cubes and meshes), or "*" for the whole model'),
          face: anyFace().optional().describe('One face'),
          faces: z.union([z.array(anyFace()), z.literal('all')]).optional().describe('Several faces, or "all" — expands the op per face. On meshes ["up"] = every face pointing up.'),
        }).optional().describe('Paint onto faces using normalized 0-1 coordinates. Each op paints onto the FACE\'S OWN texture (multi-texture formats safe). Pass "face" for one, "faces" for many. Mesh faces: 0-1 spans the UV polygon\'s bounding box and paint is clipped pixel-exactly to the polygon; "space":"world" gradients are sampled per texel from its world height.'),
      })).min(1),
    },
    annotations: mutating,
  }, forward('paint_texture'));

  server.registerTool('paint_faces', {
    title: 'Paint faces solid colors',
    description: 'Fill whole cube or mesh faces with solid colors in one call — "paint this face of this cube this color" with zero UV math. Pass a cube, a mesh, a GROUP (recurses into all its cubes and meshes), or "*" for the whole model. Mesh faces are filled exactly inside their UV polygon. Each face\'s own texture and UV rect are resolved automatically; opacity 1 overwrites, <1 blends. NOTE: faces sharing UV space (e.g. mirrored limbs reusing a rect) get painted together — give faces their own UV space first (generate_texture_template) for independent colors.',
    inputSchema: {
      targets: z.array(z.object({
        element: z.string().describe('Cube, mesh or group name/uuid, or "*" for the whole model. A rig\'s top bone is often EMPTY — target a group that actually holds elements, or "*".'),
        faces: z.union([z.array(anyFace()), z.literal('all')]).optional().describe('Face keys, default "all". On meshes a direction ("up") picks every face pointing that way.'),
        color: z.string().describe('CSS color'),
        opacity: z.number().optional().describe('0-1, default 1 (overwrite)'),
      })).min(1),
      texture: z.string().optional().describe('Fallback texture for faces that have none assigned'),
      layer: layerParam(),
    },
    annotations: mutating,
  }, forward('paint_faces'));

  server.registerTool('resize_texture', {
    title: 'Resize texture',
    description: 'Resize a texture bitmap (nearest-neighbor). stretch: false keeps content at top-left instead of scaling.',
    inputSchema: {
      texture: z.string(),
      width: z.number(), height: z.number(),
      stretch: z.boolean().optional(),
      update_uv_size: z.boolean().optional(),
    },
    annotations: mutating,
  }, forward('resize_texture'));

  server.registerTool('set_texture_resolution', {
    title: 'Set project UV resolution',
    description: 'Set the project texture/UV grid size (e.g. 64x64). modify_uv scales existing UV mappings proportionally.',
    inputSchema: {
      width: z.number(), height: z.number(),
      modify_uv: z.boolean().optional(),
    },
    annotations: mutating,
  }, forward('set_texture_resolution'));
}
