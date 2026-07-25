// All MCP tool registrations. Handlers forward to the Blockbench plugin over
// the WS bridge; schemas are kept flat (no top-level unions) for maximum
// client compatibility.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forward, toToolResult, errorResult } from './respond';
import { call, isConnected, getPluginInfo } from './bridge';

const vec3 = () => z.array(z.number()).length(3);
const vec2 = () => z.array(z.number()).length(2);
const molangValue = () => z.union([z.number(), z.string()]);
const vec3molang = () => z.array(molangValue()).length(3).describe('[x, y, z] — numbers or Molang expression strings like "math.sin(query.anim_time*360)*10"');

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const mutating = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const faceKeys = ['north', 'south', 'east', 'west', 'up', 'down'] as const;
const cubeFaceSchema = z.object({
  uv: z.array(z.number()).length(4).optional().describe('Face UV rect [x1, y1, x2, y2] in UV units (0..texture UV size). Swap x1/x2 to mirror.'),
  rotation: z.number().optional().describe('UV rotation: 0, 90, 180 or 270'),
  texture: z.string().nullable().optional().describe('Texture name/uuid, or null to hide this face'),
  cullface: z.string().optional().describe('Java block culling: north/south/east/west/up/down or empty'),
  tint: z.number().optional(),
  enabled: z.boolean().optional(),
}).describe('Per-face settings');
const facesSchema = z.object({
  north: cubeFaceSchema.optional(), south: cubeFaceSchema.optional(),
  east: cubeFaceSchema.optional(), west: cubeFaceSchema.optional(),
  up: cubeFaceSchema.optional(), down: cubeFaceSchema.optional(),
}).describe('Per-face UV/texture settings, keys: north south east west up down');

const cameraSchema = z.object({
  position: vec3().describe('Camera position [x, y, z]'),
  target: vec3().optional().describe('Look-at point, default [0, 8, 0]'),
  projection: z.enum(['perspective', 'orthographic']).optional(),
  fov: z.number().optional().describe('Field of view in degrees (perspective)'),
}).describe('Explicit camera placement (alternative to angle presets)');

const anglePresets = 'view (current viewport), initial, top, bottom, north, south, east, west, isometric_right, isometric_left, true_isometric_right, true_isometric_left';

export function registerTools(server: McpServer) {
  // ───────────────────────────── status & project ─────────────────────────────

  server.registerTool('get_status', {
    title: 'Get Blockbench status',
    description: 'Check the connection to Blockbench and get the app version, open project tabs, current project — and "paths": the user\'s home/desktop/temp folders and path separator. Call this first if other tools fail, or whenever you need an absolute path for save_project / export_model / render output (get_project_info returns more: last-used folder per file type and recent project paths).',
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    if (!isConnected()) {
      return toToolResult({
        connected: false,
        help: 'Blockbench is not connected. Start Blockbench and make sure the "Blockbench MCP Bridge" plugin is installed and enabled (File > Plugins). It auto-connects within ~3 seconds.',
      });
    }
    try {
      const result = await call('get_status', {});
      return toToolResult({ ...result, ...getPluginInfo() });
    } catch (err) {
      return errorResult(err);
    }
  });

  server.registerTool('list_formats', {
    title: 'List model formats',
    description: 'List all Blockbench model formats with their capability flags (animations, meshes, bone rig, box UV, ...). Use before create_project to pick the right format.',
    inputSchema: {},
    annotations: readOnly,
  }, forward('list_formats'));

  server.registerTool('create_project', {
    title: 'Create project',
    description: 'Create a new Blockbench project. Formats: "bedrock" (Minecraft Bedrock entity with bone animations — the usual choice for animated models), "bedrock_block" (static Bedrock block), "java_block" (Java block/item with display transforms, 22.5° rotation steps), "free" (generic: meshes + animations, most flexible), "modded_entity", "optifine_entity", "skin". Groups act as animation bones in bone-rig formats.',
    inputSchema: {
      format: z.string().default('bedrock').describe('Format id, see list_formats'),
      name: z.string().optional().describe('Project/model name'),
      model_identifier: z.string().optional().describe('Geometry identifier (bedrock: geometry.<id>)'),
      texture_width: z.number().optional().describe('Texture UV grid width, default 16'),
      texture_height: z.number().optional().describe('Texture UV grid height, default 16'),
    },
    annotations: mutating,
  }, forward('create_project'));

  server.registerTool('get_project_info', {
    title: 'Get project info',
    description: 'Full orientation snapshot of the current project: format capabilities, texture size, element/bone/texture/animation inventory, open tabs, and "paths" — the project save/export path, the user\'s home/desktop/temp/appdata folders, the folder they last saved each file type to (paths.last_used.model / texture / screenshot / gltf / animation ...) and recent project paths. Use those to build the absolute paths save_project and export_model require. Prefer this to orient yourself before editing.',
    inputSchema: {},
    annotations: readOnly,
  }, forward('get_project_info'));

  server.registerTool('set_project_settings', {
    title: 'Set project settings',
    description: 'Change project name, geometry identifier, texture resolution (UV grid), and format-specific options.',
    inputSchema: {
      name: z.string().optional(),
      model_identifier: z.string().optional(),
      texture_width: z.number().optional(),
      texture_height: z.number().optional(),
      modify_uv: z.boolean().optional().describe('When resizing texture grid: scale existing UVs proportionally'),
      ambientocclusion: z.boolean().optional(),
      front_gui_light: z.boolean().optional(),
      java_block_version: z.enum(['1.9.0', '1.21.6', '1.21.11']).optional().describe('java_block only: 1.21.11+ removes rotation limits'),
      bedrock_animation_mode: z.enum(['entity', 'attachable_first']).optional(),
    },
    annotations: mutating,
  }, forward('set_project_settings'));

  server.registerTool('open_project', {
    title: 'Open project file',
    description: 'Open a model file from disk as a new project tab (.bbmodel, bedrock .geo.json, java block .json, .jem, ...).',
    inputSchema: { path: z.string().describe('Absolute file path') },
    annotations: mutating,
  }, forward('open_project'));

  server.registerTool('save_project', {
    title: 'Save project (.bbmodel)',
    description: 'Save the current project as a .bbmodel file (Blockbench native format, includes textures and animations). Use export_model for game-ready formats. Need a folder to write to? get_status / get_project_info return "paths" (home, desktop, temp, and the folder the user last saved each file type to) — no need to ask.',
    inputSchema: { path: z.string().optional().describe('Absolute path ending in .bbmodel. Optional if the project was saved before. Build it from get_project_info "paths" (e.g. paths.desktop or paths.last_used.model).') },
    annotations: mutating,
  }, forward('save_project'));

  server.registerTool('select_project_tab', {
    title: 'Switch project tab',
    description: 'Switch between open project tabs by uuid or name (see get_status).',
    inputSchema: { uuid: z.string().describe('Project uuid or display name') },
    annotations: mutating,
  }, forward('select_project_tab'));

  server.registerTool('close_project', {
    title: 'Close project',
    description: 'Close the current project tab. Fails if there are unsaved changes unless force is true.',
    inputSchema: { force: z.boolean().optional().describe('Discard unsaved changes') },
    annotations: destructive,
  }, forward('close_project'));

  // ───────────────────────────── outliner / geometry ─────────────────────────────

  server.registerTool('add_groups', {
    title: 'Add groups (bones)',
    description: 'Create groups in the outliner. IMPORTANT: in Blockbench, groups ARE the animation bones — build the bone hierarchy with groups (e.g. body > head, body > leg_left...) and put cubes inside them. Order matters: parents must exist before children; groups created earlier in the same batch can be referenced by name as parents. The group "origin" is the pivot point for its rotation and animation. Rotations are degrees, Euler order ZYX: +X swings a hanging limb forward (toward -Z/north, the way entities face).',
    inputSchema: {
      groups: z.array(z.object({
        name: z.string().describe('Bone name (bone-rig formats allow a-zA-Z0-9_)'),
        parent: z.string().optional().describe('Parent group name/uuid, or "root" (default)'),
        origin: vec3().optional().describe('Pivot point [x, y, z] — rotations and animations rotate around this'),
        rotation: vec3().optional().describe('Rest rotation in degrees'),
        bedrock_binding: z.string().optional().describe('Bedrock: Molang binding expression (attachables)'),
        visibility: z.boolean().optional(),
      })).min(1),
    },
    annotations: mutating,
  }, forward('add_groups'));

  server.registerTool('add_cubes', {
    title: 'Add cubes',
    description: 'Create cubes (boxes) — the building blocks of Minecraft-style models. Each cube spans from "from" to "to" in world units (1 unit = 1/16 block; a full block is 16x16x16; +X east, -Z north = the direction entities face, y=0 is the ground). Put cubes in groups (bones) via "parent" so they can be animated. "origin" + "rotation" rotate the cube itself (degrees, Euler ZYX; java_block limits rotation to ±45° in 22.5° steps on one axis). Use "inflate" for overlays like clothing. Per-face UVs/textures go in "faces"; box_uv cubes use "uv_offset" instead. Set "mirror": true to also create the X-mirrored twin (auto-renamed left↔right, parented into the mirrored-name group when it exists).',
    inputSchema: {
      cubes: z.array(z.object({
        name: z.string().optional(),
        parent: z.string().optional().describe('Group name/uuid to put the cube in (recommended for animation)'),
        from: vec3().describe('Lower corner [x, y, z]'),
        to: vec3().describe('Upper corner [x, y, z]'),
        origin: vec3().optional().describe('Rotation pivot; defaults to parent group origin in bone-rig formats'),
        rotation: vec3().optional().describe('Rotation in degrees'),
        mirror: z.boolean().optional().describe('Also create the X-mirrored twin (build left side once, get both)'),
        inflate: z.number().optional().describe('Expand the cube on all sides without changing UV (overlays)'),
        box_uv: z.boolean().optional().describe('Use Minecraft box UV unwrap instead of per-face UV'),
        uv_offset: vec2().optional().describe('Box UV: top-left position of the unwrap on the texture'),
        mirror_uv: z.boolean().optional().describe('Box UV: mirror the unwrap (left/right limbs)'),
        autouv: z.number().optional().describe('0 = keep UV fixed on resize (default), 1 = auto-resize UV. Initial per-face UVs are auto-mapped to the cube size unless "faces" is given.'),
        texture: z.string().nullable().optional().describe('Texture name/uuid for all faces (default: current default texture)'),
        faces: facesSchema.optional(),
        visibility: z.boolean().optional(),
        shade: z.boolean().optional(),
        rescale: z.boolean().optional(),
        color: z.number().optional().describe('Marker color index 0-7'),
      })).min(1),
      texture: z.string().optional().describe('Default texture for all cubes in this call'),
    },
    annotations: mutating,
  }, forward('add_cubes'));

  server.registerTool('add_meshes', {
    title: 'Add meshes (free-form polygons)',
    description: 'Create free-form polygon meshes (only in the "free" format — check get_project_info). Define named vertices and faces of 3-4 vertex keys. Faces are auto-UV-projected unless you provide per-vertex "uv". For standard shapes prefer add_mesh_primitive.',
    inputSchema: {
      meshes: z.array(z.object({
        name: z.string().optional(),
        parent: z.string().optional(),
        position: vec3().optional().describe('Mesh origin — vertices are relative to this'),
        rotation: vec3().optional(),
        vertices: z.record(z.string(), vec3()).describe('Vertex positions keyed by your own ids: {"a": [0,0,0], "b": [16,0,0], ...}'),
        faces: z.array(z.object({
          vertices: z.array(z.string()).min(3).max(4).describe('3-4 vertex keys, counter-clockwise = outward normal'),
          uv: z.record(z.string(), vec2()).optional().describe('Optional UV per vertex key'),
        })),
        texture: z.string().optional(),
      })).min(1),
    },
    annotations: mutating,
  }, forward('add_meshes'));

  server.registerTool('add_mesh_primitive', {
    title: 'Add mesh primitive',
    description: 'Generate a primitive mesh shape ("free" format only): plane, pyramid, cylinder, cone, sphere, torus. Faster and cleaner than hand-building vertices.',
    inputSchema: {
      shape: z.enum(['plane', 'pyramid', 'cylinder', 'cone', 'sphere', 'torus']),
      name: z.string().optional(),
      parent: z.string().optional(),
      position: vec3().optional(),
      rotation: vec3().optional(),
      diameter: z.number().optional().describe('Default 16'),
      height: z.number().optional().describe('Default 16 (cylinder/cone/pyramid)'),
      sides: z.number().optional().describe('Segments, default 16'),
      minor_diameter: z.number().optional().describe('Torus tube diameter, default diameter/4'),
      texture: z.string().optional(),
    },
    annotations: mutating,
  }, forward('add_mesh_primitive'));

  server.registerTool('add_planes', {
    title: 'Add planes (fur/foliage cards)',
    description: 'Create flat planes — zero-thickness cubes with only their two large faces active. Works in EVERY format (bedrock included; vanilla uses the same trick for grass/fur). THE fur workflow for fluffy models: 1) model the body normally, 2) add fur planes along silhouette edges (back, tail, cheeks, chest) — single "planes" for tufts/ears/whiskers, "strips" for rows of overlapping tufts along a line, tilted outward 10-35°, 3) give them UV space on an alpha texture and cut jagged silhouettes with paint_texture op "jagged_edge" (mode "erase"). "at" is the center of the BASE edge and the default pivot, so rotation/tilt swings the card around its attachment line.',
    inputSchema: {
      planes: z.array(z.object({
        name: z.string().optional(),
        parent: z.string().optional().describe('Group (bone) to attach to'),
        at: vec3().describe('Center of the base edge [x, y, z] — the attachment point'),
        width: z.number().describe('Width in units'),
        height: z.number().describe('Height (up for vertical planes, along z for up/down facing)'),
        facing: z.enum(['north', 'south', 'east', 'west', 'up', 'down']).optional().describe('Normal direction of the card, default north (flat on the x/y plane)'),
        rotation: vec3().optional().describe('Degrees around origin — tilt fur cards outward, e.g. [15, 0, 0]'),
        origin: vec3().optional().describe('Pivot, default = "at" (base edge)'),
        texture: z.string().optional(),
        uv: z.array(z.number()).length(4).optional().describe('Face UV rect [x1,y1,x2,y2]; back face is auto-mirrored'),
        double_sided: z.boolean().optional().describe('default true — false hides the back face'),
        shade: z.boolean().optional(),
      })).optional(),
      strips: z.array(z.object({
        from: vec3().describe('Base line start [x, y, z]'),
        to: vec3().describe('Base line end'),
        count: z.number().describe('Number of tufts along the line (max 64)'),
        height: z.number().describe('Tuft height in units'),
        width: z.number().optional().describe('Per-tuft width; default segment length × (1+overlap)'),
        overlap: z.number().optional().describe('Fractional overlap between neighboring tufts, default 0.3'),
        tilt: z.number().optional().describe('Outward tilt in degrees (rotation around the strip axis)'),
        alternate_tilt: z.boolean().optional().describe('Alternate tilt sign per tuft (ruffled look)'),
        jitter: z.number().optional().describe('0-1 random variation of height/tilt (seeded, reproducible), default 0.25'),
        seed: z.number().optional(),
        parent: z.string().optional(),
        texture: z.string().optional(),
        uv: z.array(z.number()).length(4).optional().describe('UV rect shared by all tufts in the strip'),
        name_prefix: z.string().optional().describe('default "fur"'),
        double_sided: z.boolean().optional(),
      })).optional().describe('Rows of overlapping tufts along a base line — the main fur silhouette tool. Tuft orientation follows the from→to direction automatically (cards face perpendicular to the line).'),
      texture: z.string().optional().describe('Default texture for all planes in this call'),
    },
    annotations: mutating,
  }, forward('add_planes'));

  server.registerTool('add_locators', {
    title: 'Add locators',
    description: 'Create locators — named attachment points for particles, items, leads and effects (bedrock formats). Positioned in world units, parented into bones so they follow animation.',
    inputSchema: {
      locators: z.array(z.object({
        name: z.string(),
        parent: z.string().optional().describe('Group (bone) name/uuid'),
        position: vec3(),
        rotation: vec3().optional(),
      })).min(1),
    },
    annotations: mutating,
  }, forward('add_locators'));

  server.registerTool('mirror_elements', {
    title: 'Mirror elements',
    description: 'Mirror elements/groups across a symmetry plane — in place, or as mirrored copies (duplicate: true — build the left side once, generate the right). Handles cubes (geometry + rotation + box-UV mirror flag + face swap), groups/bones (recursively, with pivots), and meshes (vertices + winding). Names auto-swap left/right tokens (left↔right, _l↔_r, ...). Default plane: X (center 0 on centered-grid formats, 8 on java_block).',
    inputSchema: {
      ids: z.array(z.string()).min(1).describe('Elements or groups (groups mirror their whole subtree)'),
      axis: z.enum(['x', 'y', 'z']).optional().describe('Mirror axis (plane normal), default x — the left/right symmetry of characters'),
      center: z.number().optional().describe('Plane position on that axis; default 0 (centered formats) / 8 (java_block)'),
      duplicate: z.boolean().optional().describe('true = keep originals and create mirrored copies'),
      rename: z.boolean().optional().describe('Swap left/right name tokens, default true'),
    },
    annotations: mutating,
  }, forward('mirror_elements'));

  server.registerTool('validate_model', {
    title: 'Validate model',
    description: 'Model health check. Reports: (1) cube-cube INTERSECTIONS via exact OBB overlap tests — at the rest pose, or posed at animation times (pass "animation" + optional "times") to catch limbs clipping through the body mid-walk; penetration depth is in units. Overlaps inside the SAME bone are skipped by default (intentional in blocky modeling). (2) Static findings: degenerate cubes, elements outside any bone, untextured faces, UVs out of texture bounds, duplicate bone names, java_block rotation violations. (3) Model stats. Run before export and after big animation passes.',
    inputSchema: {
      animation: z.string().optional().describe('Check poses of this animation instead of the rest pose'),
      times: z.array(z.number()).optional().describe('Animation times in seconds (default: 8 even samples over its length)'),
      tolerance: z.number().optional().describe('Ignore penetrations shallower than this (units), default 0.01'),
      include_same_bone: z.boolean().optional().describe('Also report overlaps between cubes of the same bone'),
      max_pairs: z.number().optional().describe('Max intersection pairs reported, default 40'),
      checks: z.boolean().optional().describe('Run static findings, default true'),
      intersections: z.boolean().optional().describe('Run intersection detection, default true'),
    },
    annotations: readOnly,
  }, forward('validate_model', 60_000));

  server.registerTool('query_geometry', {
    title: 'Query world-space geometry',
    description: 'Measure the model in WORLD space, optionally posed at an animation time: overall bounding box, the LOWEST point (which element touches the ground and where — for planting feet at y=0), per-element AABBs, bone pivot world positions. Pass "animation" + "time" for one pose, or "times" for several (compact per-time summaries). This replaces eval_code for "where is X at t=0.3" questions.',
    inputSchema: {
      elements: z.array(z.string()).optional().describe('Limit to these elements/groups (default: all visible)'),
      animation: z.string().optional(),
      time: z.number().optional().describe('Seconds'),
      times: z.array(z.number()).optional(),
      include_elements: z.boolean().optional().describe('Per-element AABB list (default: true for single pose ≤150 elements)'),
      include_bones: z.boolean().optional().describe('Bone pivot world positions (default: true for single pose)'),
    },
    annotations: readOnly,
  }, forward('query_geometry', 60_000));

  server.registerTool('list_outline', {
    title: 'List outliner',
    description: 'Get the full outliner hierarchy: groups (bones) and elements with names, uuids, positions. Your map of the model — use it to find ids for other tools.',
    inputSchema: {
      include_elements: z.boolean().optional().describe('false = groups/bones only'),
      max_depth: z.number().optional(),
    },
    annotations: readOnly,
  }, forward('list_outline'));

  server.registerTool('get_element', {
    title: 'Get element details',
    description: 'Full details of one element or group: geometry, per-face UVs and textures, mesh vertices/faces with keys.',
    inputSchema: { id: z.string().describe('uuid or name (from list_outline)') },
    annotations: readOnly,
  }, forward('get_element'));

  server.registerTool('update_elements', {
    title: 'Update elements',
    description: 'Batch-modify properties of cubes, meshes, groups: geometry (from/to/origin/rotation/inflate), name, visibility, parenting ("parent"), per-face settings ("faces"), mesh vertex positions ("vertices": set to null to delete a vertex). Moving a GROUP origin moves its pivot.',
    inputSchema: {
      elements: z.array(z.object({
        id: z.string().describe('uuid or name'),
        name: z.string().optional(),
        from: vec3().optional(), to: vec3().optional(),
        origin: vec3().optional(), rotation: vec3().optional(),
        position: vec3().optional().describe('For locators/null objects'),
        inflate: z.number().optional(),
        visibility: z.boolean().optional(),
        shade: z.boolean().optional(),
        box_uv: z.boolean().optional(),
        uv_offset: vec2().optional(),
        mirror_uv: z.boolean().optional(),
        autouv: z.number().optional(),
        color: z.number().optional(),
        parent: z.string().optional().describe('New parent group (or "root")'),
        faces: facesSchema.optional(),
        vertices: z.record(z.string(), z.union([vec3(), z.null()])).optional().describe('Mesh only: move vertices, null deletes'),
        bedrock_binding: z.string().optional(),
      })).min(1),
    },
    annotations: mutating,
  }, forward('update_elements'));

  server.registerTool('delete_elements', {
    title: 'Delete elements',
    description: 'Delete elements/groups by id. Deleting a group deletes its children too. Undoable in Blockbench.',
    inputSchema: { ids: z.array(z.string()).min(1) },
    annotations: destructive,
  }, forward('delete_elements'));

  server.registerTool('duplicate_elements', {
    title: 'Duplicate elements',
    description: 'Duplicate elements or whole groups (with children), optionally offsetting the copies. For symmetric limbs prefer mirror_elements with duplicate: true — it also reflects geometry, pivots and names.',
    inputSchema: {
      ids: z.array(z.string()).min(1),
      offset: vec3().optional().describe('Translation applied to the copies'),
      name: z.string().optional().describe('Rename (single duplicate only)'),
    },
    annotations: mutating,
  }, forward('duplicate_elements'));

  server.registerTool('select_elements', {
    title: 'Select elements',
    description: 'Set the selection (some Blockbench actions operate on selected elements).',
    inputSchema: {
      ids: z.array(z.string()).optional(),
      mode: z.enum(['all', 'none']).optional(),
    },
    annotations: mutating,
  }, forward('select_elements'));

  // ───────────────────────────── textures & painting ─────────────────────────────

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
      apply_to_all: z.boolean().optional().describe('Apply to all elements after creating'),
    },
    annotations: mutating,
  }, forward('create_texture'));

  server.registerTool('generate_texture_template', {
    title: 'Generate texture template',
    description: 'Auto-generate a texture with all element UVs laid out (like Blockbench "Create Template"). Re-arranges element UVs onto the new texture — do this AFTER modeling, BEFORE painting. Then use paint_texture with face targets.',
    inputSchema: {
      name: z.string().optional(),
      pixel_density: z.number().optional().describe('Texture pixels per model unit x16. 16 = 1px per unit (default), 32 = 2px per unit'),
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
      element: z.string().optional().describe('Crop to this cube/group\'s UV region ("*" = every cube in the model)'),
      face: z.enum(faceKeys).optional().describe('Crop to one face of that element'),
      faces: z.union([z.array(z.enum(faceKeys)), z.literal('all')]).optional().describe('Crop to several faces (default: all faces of the element)'),
      padding: z.number().optional().describe('Extra UV units around the crop, default 0 — use 1-2 to see neighbouring pixels'),
    },
    annotations: readOnly,
  }, forward('get_texture'));

  server.registerTool('import_texture', {
    title: 'Import texture file',
    description: 'Import an image file from disk as a texture.',
    inputSchema: { path: z.string().describe('Absolute path to png/jpeg/webp/tga') },
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
    description: 'Draw on a texture with declarative ops (batched in one call, one undo step). Op types: "pixel" {pixels: [[x,y],...]}, "line" {from, to, thickness?}, "rect" {from, to, filled?, thickness?}, "ellipse" {center, radius: [rx,ry], filled?}, "fill" (bucket) {at, tolerance?}, "gradient" (see "stops" and "space"), "clear" {from, to}, "jagged_edge" (pixel-art fur teeth along one rect edge — mode "erase" cuts the silhouette into transparency for fur planes, mode "color" draws colored teeth), "noise" (seeded speckle of color/color2; with no target and no from/to it covers the WHOLE bitmap), "strands" (seeded fur dashes whose count and length scale with the target rect, so one op reads right on a small paw and a big flank). Every op takes "color" (CSS string) and "opacity" (0-1).\n\nTARGETING: "target": {element, face} paints one cube face; "target": {element, faces: "all" | ["north",...]} paints many, and "element" may be a GROUP (recurses into every cube in it) — one op then expands to one op per face. Targeted ops use NORMALIZED 0-1 coordinates mapped onto each face\'s UV rect; untargeted ops use absolute BITMAP pixels.\n\nSHADING ACROSS CUBES: a face-local gradient restarts on every cube, which makes a limb built from several cubes look banded. Pass "space": "world" on a gradient (with a face target) to position the stops along the MODEL\'s Y extent instead, so neighbouring cubes continue the same ramp seamlessly. For plain solid faces prefer paint_faces. Verify with get_texture, inspect_uv or capture_screenshot.',
    inputSchema: {
      texture: z.string().optional().describe('Texture name/uuid (default: selected)'),
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
        filled: z.boolean().optional(),
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
          element: z.string().describe('Cube or GROUP name/uuid (a group recurses into all its cubes), or "*" for every cube in the model'),
          face: z.enum(faceKeys).optional().describe('One face key'),
          faces: z.union([z.array(z.enum(faceKeys)), z.literal('all')]).optional().describe('Several face keys, or "all" — expands the op per face'),
        }).optional().describe('Paint onto cube faces using normalized 0-1 coordinates. Each op paints onto the FACE\'S OWN texture (multi-texture formats safe). Pass "face" for one, "faces" for many.'),
      })).min(1),
    },
    annotations: mutating,
  }, forward('paint_texture'));

  server.registerTool('paint_faces', {
    title: 'Paint cube faces solid colors',
    description: 'Fill whole cube faces with solid colors in one call — "paint this face of this cube this color" with zero UV math. Pass a cube, a GROUP (recurses into all its cubes), or "*" for every cube in the model. Each face\'s own texture and UV rect are resolved automatically; opacity 1 overwrites, <1 blends. NOTE: faces sharing UV space (e.g. mirrored limbs reusing a rect) get painted together — give faces their own UV space first (generate_texture_template) for independent colors.',
    inputSchema: {
      targets: z.array(z.object({
        element: z.string().describe('Cube or group name/uuid, or "*" for every cube in the model. A rig\'s top bone is often EMPTY — target a group that actually holds cubes, or "*".'),
        faces: z.union([z.array(z.enum(faceKeys)), z.literal('all')]).optional().describe('Face keys, default "all"'),
        color: z.string().describe('CSS color'),
        opacity: z.number().optional().describe('0-1, default 1 (overwrite)'),
      })).min(1),
      texture: z.string().optional().describe('Fallback texture for faces that have none assigned'),
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

  // ───────────────────────────── UV ─────────────────────────────

  server.registerTool('set_cube_uv', {
    title: 'Set cube UV',
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
    annotations: mutating,
  }, forward('set_cube_uv'));

  server.registerTool('set_mesh_uv', {
    title: 'Set mesh UV',
    description: 'Set per-vertex UV coordinates of mesh faces. Get face/vertex keys from get_element.',
    inputSchema: {
      mesh: z.string(),
      faces: z.record(z.string(), z.record(z.string(), vec2())).describe('{face_key: {vertex_key: [u, v]}}'),
    },
    annotations: mutating,
  }, forward('set_mesh_uv'));

  server.registerTool('auto_uv', {
    title: 'Auto-UV elements',
    description: 'Automatically size face UVs to match element dimensions (cubes) / auto-project (meshes).',
    inputSchema: { elements: z.array(z.string()).optional().describe('Default: all') },
    annotations: mutating,
  }, forward('auto_uv'));

  server.registerTool('inspect_uv', {
    title: 'Inspect UV mapping',
    description: 'Diagnose how the texture actually maps onto the model — the first thing to run when a texture "looks wrong on the model" but the texture image itself looks fine. Reports, per cube face: UV rotation, mirrored rects, rects whose aspect does not match the face (stretched or turned 90°), UV rects SHARED by several faces (painting one repaints all), faces with no texture, fully transparent pixels inside a face rect (they render see-through), atlas coverage, and the bitmap-to-UV-grid scale (how many bitmap pixels one UV unit is — needed for absolute paint coordinates). Returns a "findings" list with severities plus the raw counts. NOTE: mirroring on "up"/"down" faces is Blockbench\'s normal box unwrap, not a defect.',
    inputSchema: {
      texture: z.string().optional().describe('Limit the report to one texture (default: all)'),
      scan_pixels: z.boolean().optional().describe('Scan each face rect for transparent pixels (default true; set false for a fast structural-only check on huge models)'),
      max_samples: z.number().optional().describe('Example faces listed per problem type, default 6'),
    },
    annotations: readOnly,
  }, forward('inspect_uv'));

  // ───────────────────────────── animation ─────────────────────────────

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
        file: z.string().optional().describe('Local file for preview'),
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

  // ───────────────────────────── display / camera / io ─────────────────────────────

  server.registerTool('set_display_transforms', {
    title: 'Set item display transforms',
    description: 'Configure how a java_block/bedrock_block item model is displayed in each slot: gui, ground, head, firstperson/thirdperson left/right hand, fixed (item frame).',
    inputSchema: {
      slot: z.enum(['thirdperson_righthand', 'thirdperson_lefthand', 'firstperson_righthand', 'firstperson_lefthand', 'ground', 'gui', 'head', 'fixed']),
      rotation: vec3().optional(),
      translation: vec3().optional(),
      scale: vec3().optional(),
      mirror: z.array(z.boolean()).length(3).optional(),
    },
    annotations: mutating,
  }, forward('set_display_transforms'));

  server.registerTool('get_display_transforms', {
    title: 'Get display transforms',
    description: 'Read all configured display slots.',
    inputSchema: {},
    annotations: readOnly,
  }, forward('get_display_transforms'));

  server.registerTool('capture_screenshot', {
    title: 'Screenshot the model',
    description: `Render the current model to an image (offscreen renderer — works even while the Blockbench window is minimized or covered). Use often — after building geometry, texturing, posing. Angle presets: ${anglePresets}; or pass an explicit camera. The camera auto-fits the model bounds for presets.`,
    inputSchema: {
      angle: z.string().optional(),
      camera: cameraSchema.optional(),
      resolution: z.number().optional().describe('Default 960, max 1600'),
      shading: z.boolean().optional().describe('Flat lighting when false'),
      background: z.string().optional().describe('CSS color for an opaque backdrop (default: transparent). Useful to tell "transparent model" apart from "blank image".'),
    },
    annotations: readOnly,
  }, forward('capture_screenshot', 60_000));

  server.registerTool('capture_multi_view', {
    title: 'Multi-view screenshots',
    description: 'Render the model from several angles at once (default: north, east, top, isometric_right). The fastest way to check overall proportions.',
    inputSchema: {
      views: z.array(z.string()).optional(),
      resolution: z.number().optional().describe('Per-view size, default 480'),
      background: z.string().optional().describe('CSS color for an opaque backdrop (default: transparent)'),
    },
    annotations: readOnly,
  }, forward('capture_multi_view', 120_000));

  server.registerTool('export_model', {
    title: 'Export model',
    description: 'Export to game/DCC formats without dialogs: bbmodel, bedrock_geo (.geo.json), java_block (.json), gltf, glb, obj (+mtl+textures), fbx, dae, stl, optifine_jem. Textures embed or export alongside depending on format.',
    inputSchema: {
      format: z.enum(['bbmodel', 'bedrock_geo', 'java_block', 'gltf', 'glb', 'obj', 'fbx', 'dae', 'stl', 'optifine_jem']),
      path: z.string().describe('Absolute output file path — build it from get_project_info "paths" (paths.desktop, paths.last_used.gltf/obj/model, ...)'),
      options: z.record(z.string(), z.any()).optional().describe('Codec options, e.g. {scale: 1, embed_textures: true, animations: true} for gltf'),
    },
    annotations: mutating,
  }, forward('export_model', 60_000));

  server.registerTool('export_animations', {
    title: 'Export animations (bedrock)',
    description: 'Export animations to a Bedrock .animation.json file.',
    inputSchema: {
      path: z.string(),
      animations: z.array(z.string()).optional().describe('Names/uuids (default: all)'),
    },
    annotations: mutating,
  }, forward('export_animations'));

  server.registerTool('import_model', {
    title: 'Import model file',
    description: 'Import a model file: as a new project tab, or merge a bedrock .geo.json into the current project.',
    inputSchema: {
      path: z.string(),
      merge: z.boolean().optional().describe('Merge into current project (bedrock geometry only)'),
    },
    annotations: mutating,
  }, forward('import_model'));

  server.registerTool('get_model_json', {
    title: 'Get compiled model JSON',
    description: 'Return the compiled model file content inline (bedrock_geo/java_block/bbmodel/gltf) without writing to disk — for inspection.',
    inputSchema: {
      format: z.enum(['bbmodel', 'bedrock_geo', 'java_block', 'gltf']).optional(),
      max_length: z.number().optional().describe('Truncation limit, default 60000 chars'),
    },
    annotations: readOnly,
  }, forward('get_model_json'));

  // ───────────────────────────── escape hatches ─────────────────────────────

  server.registerTool('run_action', {
    title: 'Run Blockbench action',
    description: 'Trigger any built-in Blockbench action by id (menu items, tools). Escape hatch for features without a dedicated tool. Errors suggest similar ids if not found.',
    inputSchema: {
      id: z.string().describe('Action id, e.g. "screenshot_model"'),
      confirm_dialog: z.boolean().optional().describe('Auto-confirm a dialog the action opens'),
      dialog_values: z.record(z.string(), z.any()).optional().describe('Form values to fill before confirming'),
    },
    annotations: mutating,
  }, forward('run_action'));

  server.registerTool('eval_code', {
    title: 'Run JavaScript in Blockbench',
    description: 'Execute raw JavaScript inside Blockbench with full API access (Project, Cube, Group, Mesh, Animation, Texture, Undo, Canvas, Codecs, THREE...). The ultimate escape hatch when no dedicated tool fits. Wrapped in an undo step by default; returned promises are awaited. The value of the last expression is returned, and a top-level "return" or "await" works too (the code is auto-wrapped in an async function when needed — no manual IIFE). Return a "data:image/..." string (or {__image}/{__images: [...]}) to get real images back. Large results: pass "result_file" to write the full result to disk, or raise "max_length" (default 30000 chars, truncated beyond).\n\nDO NOT require() Node modules. Blockbench gates fs/os/process/child_process/net/https/shell/... behind a SYNCHRONOUS NATIVE MODAL permission dialog that freezes the whole app — and it is invisible while the Blockbench window is minimised, so the app just appears hung and this bridge dies. Such calls are refused before the code runs. You do not need them: filesystem paths come from get_status/get_project_info ("paths") or the SystemInfo global, file writing from Blockbench.writeFile(path, {content}) or this tool\'s "result_file", reading from Blockbench.read(), path joining from the PathModule global. Only path, crypto, events, zlib, timers, url, string_decoder, querystring, constants, buffer, stream and perf_hooks load without a prompt.\n\nUse sparingly and prefer dedicated tools (query_geometry/validate_model cover most world-space math; get_texture crops to a single face).',
    inputSchema: {
      code: z.string(),
      undo: z.boolean().optional().describe('false disables undo wrapping'),
      result_file: z.string().optional().describe('Absolute path — write the full serialized result here instead of returning it inline'),
      max_length: z.number().optional().describe('Inline result character limit before truncation, default 30000'),
      allow_native_modules: z.boolean().optional().describe('Opt out of the require() guard. Only with the Blockbench window in the FOREGROUND — a permission modal will block the app until a human answers it.'),
    },
    annotations: destructive,
  }, forward('eval_code', 60_000));

  server.registerTool('undo', {
    title: 'Undo',
    description: 'Undo the last edit(s) in Blockbench. All MCP edits are undoable.',
    inputSchema: { steps: z.number().optional() },
    annotations: mutating,
  }, forward('undo'));

  server.registerTool('redo', {
    title: 'Redo',
    description: 'Redo previously undone edit(s).',
    inputSchema: { steps: z.number().optional() },
    annotations: mutating,
  }, forward('redo'));
}
