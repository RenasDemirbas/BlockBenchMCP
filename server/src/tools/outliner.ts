// Outliner and geometry: groups, cubes, meshes, locators, IK, queries.
import { z } from 'zod';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forward } from '../respond';
import { vec3, vec2, readOnly, mutating, destructive, facesSchema, shadeDirections, meshSelect } from './shared';

export function registerOutlinerTools(server: McpServer) {
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
        shade_direction_override: z.enum(shadeDirections).optional().describe('java_block 26.3+: light the whole cube as if every face pointed this way ("" = off). Replaces "shade" in that version.'),
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
    description: 'Generate a primitive mesh shape ("free" format only): plane, pyramid, cylinder, cone, sphere, torus, and the Blockbench 5.2 polyhedra icosphere, octahedron, dodecahedron (triangle meshes; "detail" subdivides them toward a sphere — an icosphere has evenly sized faces, unlike the UV "sphere"). Shapes rest on y=0 around the origin. Faster and cleaner than hand-building vertices.',
    inputSchema: {
      shape: z.enum(['plane', 'pyramid', 'cylinder', 'cone', 'sphere', 'torus', 'icosphere', 'octahedron', 'dodecahedron']),
      name: z.string().optional(),
      parent: z.string().optional(),
      position: vec3().optional(),
      rotation: vec3().optional(),
      diameter: z.number().optional().describe('Default 16'),
      height: z.number().optional().describe('Default 16 (cylinder/cone/pyramid)'),
      sides: z.number().optional().describe('Segments, default 16'),
      minor_diameter: z.number().optional().describe('Torus tube diameter, default diameter/4'),
      detail: z.number().optional().describe('icosphere/octahedron/dodecahedron subdivision level 0-4 (faces ×4 per level). Default 1 for icosphere (80 faces), 0 for the others (the plain solid).'),
      texture: z.string().optional(),
    },
    annotations: mutating,
  }, forward('add_mesh_primitive'));

  server.registerTool('edit_mesh', {
    title: 'Edit mesh topology (extrude, inset, loop cut, bevel...)',
    description: 'Box-modeling operations on a mesh, run as ordered "steps" (each its own undo step). Each step selects part of the mesh ("select"), then applies "op". select "previous" = what the last step produced (the new faces of an extrude, the inner face of an inset...), so chains like extrude → inset → extrude work in ONE call.\nOps (Blockbench\'s own tools): extrude {distance, direction: outwards|average|x+|x-|y+|y-|z+|z-, even}; inset {amount 0-100, % toward the face centre}; solidify {thickness} (give a flat cape/brim thickness); loop_cut {cuts 1-16, position 0-1, direction: which edge pair of the selected face to cut across (0/1)}; merge_vertices {distance? (by distance), center?}; dissolve_edges (select edges); create_face (select 3-4 vertices); invert_faces; split (selected faces become a new mesh).\nOps implemented here: subdivide {levels 1-3, smooth 0-1} (each quad → 4); bevel {amount, angle} chamfers every edge sharper than angle (default 30°) on a CLOSED mesh — rounds off boxy guns, boots, belts; delete {what: faces|vertices}; merge_meshes {meshes: [...]} merges others into this mesh.\nReturns per-step counts and the resulting selection. Run unwrap_mesh after the shape is final.',
    inputSchema: {
      mesh: z.string().describe('Mesh name/uuid'),
      steps: z.array(z.object({
        op: z.enum(['extrude', 'inset', 'solidify', 'loop_cut', 'merge_vertices', 'dissolve_edges', 'create_face', 'invert_faces', 'split', 'subdivide', 'bevel', 'delete', 'merge_meshes']),
        select: meshSelect().optional().describe('Default "all"'),
        distance: z.number().optional().describe('extrude: length in units; merge_vertices: merge radius'),
        direction: z.union([z.string(), z.number()]).optional().describe('extrude: outwards|average|x+|x-|y+|y-|z+|z-; loop_cut: 0 or 1'),
        even: z.boolean().optional().describe('extrude: keep thickness even on angled faces'),
        amount: z.number().optional().describe('inset: 0-100 (default 50); bevel: chamfer width in units (default 0.5)'),
        thickness: z.number().optional().describe('solidify'),
        cuts: z.number().optional().describe('loop_cut: number of cuts'),
        position: z.number().optional().describe('loop_cut: 0-1 along the face (default 0.5)'),
        spacing: z.enum(['proportional', 'even_start', 'even_end']).optional(),
        center: z.boolean().optional().describe('merge_vertices: merge into the centre'),
        levels: z.number().optional().describe('subdivide: 1-3'),
        smooth: z.number().optional().describe('subdivide: 0-1 relaxation toward neighbours (rounder)'),
        angle: z.number().optional().describe('bevel: only edges sharper than this (deg)'),
        what: z.enum(['faces', 'vertices']).optional().describe('delete'),
        meshes: z.array(z.string()).optional().describe('merge_meshes'),
      })).min(1),
    },
    annotations: mutating,
  }, forward('edit_mesh'));

  server.registerTool('add_loft', {
    title: 'Add loft (limb/tube from cross-sections)',
    description: 'Build a mesh by sweeping a cross-section through a list of rings — the fastest way to make low-poly LIMBS (upper arm → elbow → forearm → wrist), legs, baggy trousers, a torso, a neck, fingers, gun barrels, a hat crown. Each ring has a centre "at" (model units, relative to "position"), a "size" [width, depth] and an optional "twist" (deg) and "offset". Rings may bend the path freely; the profile follows it without spinning. A ring with size 0 becomes a pointed tip. profile: "box" (4 sides, the classic low-poly limb), "round" (sides 3-32) or custom [[x,y],...] points in -0.5..0.5. Normals face outward; caps close the ends. Follow with transform_mesh/edit_mesh for shaping and unwrap_mesh before painting. "free" format only.',
    inputSchema: {
      name: z.string().optional(),
      rings: z.array(z.object({
        at: vec3().describe('Ring centre'),
        size: z.union([z.number(), vec2()]).optional().describe('[width, depth] (or one number), default 2'),
        twist: z.number().optional().describe('Rotate this ring\'s profile (deg)'),
        offset: vec2().optional().describe('Shift the ring sideways in its own plane'),
      })).min(2),
      profile: z.union([z.enum(['box', 'round']), z.array(vec2())]).optional().describe('Default "box"'),
      sides: z.number().optional().describe('round profile: number of sides (default 8)'),
      caps: z.enum(['both', 'start', 'end', 'none']).optional().describe('Close the ends (default both)'),
      side: vec3().optional().describe('Which world direction the profile\'s width axis should face at the first ring (default +X, or +Z for X-pointing limbs)'),
      parent: z.string().optional(),
      position: vec3().optional().describe('Mesh origin / pivot'),
      rotation: vec3().optional(),
      texture: z.string().optional(),
    },
    annotations: mutating,
  }, forward('add_loft'));

  server.registerTool('transform_mesh', {
    title: 'Deform mesh vertices (taper, bend, twist...)',
    description: 'Shape a mesh (or part of it via "select", same spec as edit_mesh) with ordered deformers, in the mesh\'s local coordinates:\n- taper {axis, factor, start?, from?: "min"|"max"}: cross-section scales from start (1) to factor along the axis — trouser legs flaring out, a tapering finger. factor may be [a, b] per remaining axis.\n- bend {axis, angle, toward: "z"|"-z"|"x"...}: curl the part along axis toward a direction — elbows, a drooping hat brim, a curved cape.\n- twist {axis, angle}\n- scale {factor, pivot?}, rotate {angles: [x,y,z], pivot?}, move {offset}\n- smooth {factor 0-1, iterations}: relax toward neighbours (rounder, softer)\n- jitter {amount, seed}: seeded hand-made wobble that breaks the perfect primitive look.\nPivot defaults to the selection\'s bounding-box centre; ranges use the selection\'s extent.\n\nFALLOFF (proportional editing, Blockbench 5.2): "falloff": {radius, curve?, distance?} lets every op except smooth fade out over the vertices within "radius" units of the selection, so pulling a nose or bending a knee drags the surrounding surface smoothly instead of creasing at the selection edge. curve: smooth (default), linear, sharp, root, constant. distance: "linear" (straight line, default) or "connected" (along mesh edges — a nearby but separate part such as the other leg stays put).',
    inputSchema: {
      mesh: z.string().optional().describe('Mesh name/uuid'),
      meshes: z.array(z.string()).optional().describe('Several meshes, each deformed independently'),
      select: meshSelect().optional().describe('Default: the whole mesh'),
      falloff: z.object({
        radius: z.number().describe('Reach around the selection in model units'),
        curve: z.enum(['smooth', 'linear', 'sharp', 'root', 'constant']).optional().describe('How the effect fades with distance, default smooth'),
        distance: z.enum(['linear', 'connected']).optional().describe('linear = straight-line (default); connected = along mesh edges'),
      }).optional().describe('Soft selection: the ops also move nearby unselected vertices, fading to nothing at "radius"'),
      ops: z.array(z.object({
        type: z.enum(['taper', 'bend', 'twist', 'scale', 'rotate', 'move', 'smooth', 'jitter']),
        axis: z.enum(['x', 'y', 'z']).optional().describe('taper/bend/twist: along which axis (default y)'),
        factor: z.union([z.number(), vec2(), vec3()]).optional().describe('taper: end scale (number or [a,b]); scale: number or [x,y,z]; smooth: 0-1'),
        start: z.union([z.number(), vec2()]).optional().describe('taper: scale at the start, default 1'),
        from: z.enum(['min', 'max']).optional().describe('taper/bend/twist: which end is the start (default min)'),
        angle: z.number().optional().describe('bend/twist: degrees'),
        toward: z.string().optional().describe('bend: x, y, z or -x, -y, -z'),
        angles: vec3().optional().describe('rotate: degrees'),
        offset: vec3().optional().describe('move'),
        pivot: vec3().optional(),
        iterations: z.number().optional().describe('smooth'),
        amount: z.number().optional().describe('jitter: max displacement in units'),
        seed: z.number().optional(),
      })).min(1),
    },
    annotations: mutating,
  }, forward('transform_mesh'));

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

  server.registerTool('add_bounding_boxes', {
    title: 'Add bounding boxes',
    description: 'Create bounding boxes — wireframe collision/hitbox volumes (bedrock formats, and the generic "free" format since Blockbench 5.2). They do not render in screenshots and carry no texture. Parent them into a bone to follow it.',
    inputSchema: {
      boxes: z.array(z.object({
        name: z.string().optional(),
        from: vec3().describe('Lower corner [x, y, z]'),
        to: vec3().describe('Upper corner [x, y, z]'),
        function: z.array(z.enum(['collision', 'hitbox'])).optional(),
        parent: z.string().optional().describe('Group (bone) name/uuid'),
        color: z.number().optional().describe('Marker color index'),
      })).min(1),
    },
    annotations: mutating,
  }, forward('add_bounding_boxes'));

  server.registerTool('add_ik_controllers', {
    title: 'Add IK controllers (inverse kinematics)',
    description: 'Rig limbs for inverse kinematics: each controller is a null object the chain\'s END bone reaches for, so a leg or arm is animated by moving ONE point instead of keyframing every joint. "target" = end bone (foot/hand), "source" = start bone (thigh/upper arm) — always pass it, otherwise the chain runs up to the top-level bone and bends the body too. The controller is placed at the target\'s pivot unless "position" is given, so the rest pose does not change.\n\nPOLES (Blockbench 5.2): a pole is a point the middle joint bends toward — without one a knee can flip sideways. Pass "pole" (existing locator/null/group) or let the tool create one: "pole_offset" is relative to the chain\'s middle joint — [0,0,-8] makes a knee bend forward (north, the way entities face), [0,0,8] makes an elbow bend back.\n\nAnimate by keyframing the controller\'s "position" channel with set_keyframes (bone = controller name). In Blockbench 5.2.1+ a controller only acts in animations where it has a keyframe — list them in "animations" to add a neutral one. Formats without IK export (bedrock, java) need bake_ik_animation first.\n\nARMATURES (Blockbench 5.2, "free" format): target and source may be armature bones (add_armature) — the skinned mesh then bends with the chain. Without "source" an armature chain starts at the armature\'s top bone.',
    inputSchema: {
      controllers: z.array(z.object({
        name: z.string().optional().describe('Controller name, default "<target>_ik"'),
        target: z.string().describe('END of the chain: bone (group or armature bone) or locator, e.g. "foot_left"'),
        source: z.string().optional().describe('START of the chain (group or armature bone), e.g. "thigh_left" — recommended'),
        parent: z.string().optional().describe('Group to put the controller (and auto pole) in; default root'),
        position: vec3().optional().describe('Controller position (model units); default: the target\'s pivot'),
        pole: z.string().optional().describe('Existing locator / null object / group to use as the pole'),
        pole_position: vec3().optional().describe('Create a pole null object at this absolute position'),
        pole_offset: vec3().optional().describe('Create a pole at the chain\'s middle joint + this offset, e.g. [0,0,-8] for a forward-bending knee'),
        lock_rotation: z.boolean().optional().describe('Keep the end bone\'s world rotation (feet stay flat)'),
        animations: z.union([z.array(z.string()), z.literal('all')]).optional().describe('Add a neutral keyframe in these animations so the controller is active there (needed in 5.2.1+)'),
      })).min(1),
    },
    annotations: mutating,
  }, forward('add_ik_controllers'));

  server.registerTool('bake_ik_animation', {
    title: 'Bake IK into keyframes',
    description: 'Convert what the IK controllers do in one animation into plain rotation keyframes on the chain bones (sampled at the animation\'s snapping fps) — required before exporting to formats that have no IK (Bedrock .animation.json, Java). Pass detach_controllers: true to unhook the controllers afterwards so the preview shows exactly the baked motion.',
    inputSchema: {
      animation: z.string().optional().describe('Name/uuid (default: selected)'),
      detach_controllers: z.boolean().optional().describe('Clear ik_target on all controllers after baking'),
    },
    annotations: mutating,
  }, forward('bake_ik_animation', 60_000));

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
    description: 'Model health check. Reports: (1) cube-cube INTERSECTIONS via exact OBB overlap tests — at the rest pose, or posed at animation times (pass "animation" + optional "times") to catch limbs clipping through the body mid-walk; penetration depth is in units. Overlaps inside the SAME bone are skipped by default (intentional in blocky modeling). (2) DETACHED parts: cubes/meshes that float free of the main body — e.g. legs hovering 1 unit under the torso, or a paw offset from its leg. A part counts as attached when its world box touches or overlaps a part in its own, parent, child or sibling bone; each detached part is reported with its bone, nearest neighbour and the [x,y,z] gap in units, at the rest pose or at the same animation times. No need to compute gaps by hand from query_geometry. (3) Static findings: degenerate cubes, elements outside any bone, untextured faces, UVs out of texture bounds, duplicate bone names, java_block rotation violations. (4) Model stats. Run before export and after big animation passes.',
    inputSchema: {
      animation: z.string().optional().describe('Check poses of this animation instead of the rest pose'),
      times: z.array(z.number()).optional().describe('Animation times in seconds (default: 8 even samples over its length)'),
      tolerance: z.number().optional().describe('Ignore penetrations shallower than this, and gaps up to this (units), default 0.01'),
      include_same_bone: z.boolean().optional().describe('Also report overlaps between cubes of the same bone'),
      max_pairs: z.number().optional().describe('Max intersection pairs (and detached parts) reported, default 40'),
      checks: z.boolean().optional().describe('Run static findings, default true'),
      intersections: z.boolean().optional().describe('Run intersection detection, default true'),
      detached: z.boolean().optional().describe('Run detached-part detection, default true'),
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
        shade_direction_override: z.enum(shadeDirections).optional().describe('Cube, java_block 26.3+: fixed shading direction ("" = off)'),
        ik_target: z.string().nullable().optional().describe('Null object (IK controller): END bone/locator of the chain; null clears'),
        ik_source: z.string().nullable().optional().describe('Null object: START bone of the chain; null = the controller\'s parent'),
        ik_pole: z.string().nullable().optional().describe('Null object (5.2+): locator/null object/group the middle joint bends toward; null clears'),
        lock_ik_target_rotation: z.boolean().optional().describe('Null object: keep the end bone\'s world rotation (e.g. a foot stays flat)'),
        function: z.array(z.enum(['collision', 'hitbox'])).optional().describe('Bounding box only: what it is used for'),
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
}
