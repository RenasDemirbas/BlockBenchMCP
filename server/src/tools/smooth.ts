// Smooth meshes: subdivision surfaces, edge creases and smooth-by-angle shading
// through the BlockSmooth plugin, and Blockbench's own flat / smooth shading.
import { z } from 'zod';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mutating, registerGroup } from './shared';

export function registerSmoothTools(server: McpServer) {
  const mesh = { mesh: z.string().describe('Mesh name/uuid') };
  // Actions on several meshes take "mesh" OR "meshes"; the plugin fails when neither is given.
  const target = {
    mesh: mesh.mesh.optional(),
    meshes: z.array(z.string()).optional().describe('Several meshes at once (instead of "mesh")'),
  };
  const modifier = { modifier: z.union([z.string(), z.number()]).describe('Modifier id, or its index in the stack (0 = first), from "describe"') };
  const settings = {
    levels: z.number().optional().describe('subdivision: viewport levels 0-4 (default 2). Each level splits every face into 4'),
    export_levels: z.number().optional().describe('subdivision: levels in exported files 0-6 (default = levels)'),
    angle: z.number().optional().describe('smooth_by_angle: degrees 0-180 (default 30); edges folded more than this shade sharp, 180 = smooth everywhere except edges marked sharp'),
    viewport: z.boolean().optional().describe('Show this modifier in the viewport (default true)'),
    export: z.boolean().optional().describe('Apply this modifier in exported files (default true)'),
  };
  const edges = {
    edges: z.array(z.array(z.string()).length(2)).optional().describe('[[vertexA, vertexB], ...] vertex keys from get_element'),
    angle: settings.angle,
    selected: z.boolean().optional().describe('true: the edges (or the sides of the faces) selected in edit mode'),
  };

  registerGroup(server, 'smooth_mesh', {
    title: 'Smooth meshes (subdivision surfaces, creases, shading)',
    description: 'Turn a low-poly mesh into a smooth, professional surface WITHOUT destroying it — the BlockSmooth plugin\'s non-destructive modifiers, like Blender\'s Subdivision Surface and Smooth by Angle. You keep modeling the low-poly "cage" (edit_mesh, vertex moves); the viewport, capture_screenshot and every export (OBJ, FBX, glTF/GLB, Collada, STL — including skinned glTF) show the smooth result, while the .bbmodel keeps the editable cage. Needs the BlockSmooth plugin (every action but "shading" fails with install instructions without it).\n'
      + 'WORKFLOW: box-model a coarse cage with quads (edit_mesh extrude / inset / loop_cut) → "add" type subdivision (levels 2) → keep edges that must stay crisp with "crease" (1 = sharp corner, 0.3-0.7 = tight bevel) or add support loops (loop_cut) next to them → "add" type smooth_by_angle (or "sharp") for hard shading on flat panels → capture_screenshot to check → export. Quads subdivide best; triangles and poles make pinches. UVs are interpolated linearly inside each cage face, so textures and pixel-art stay put. "apply" bakes the subdivision into real geometry only if you need to edit the dense mesh.\n'
      + 'Every action returns the mesh\'s stack and face counts (cage / viewport / export); deep stacks are reduced to stay under 400k faces in the viewport and 1.5M in exports.',
    annotations: mutating,
    actions: {
      describe: {
        command: 'smooth_describe',
        description: 'The modifier stack, creased / sharp edge counts and what it produces in the viewport and in exports. Without mesh/meshes: every mesh of the project.',
        inputSchema: { ...target },
      },
      add: {
        command: 'smooth_add',
        description: 'Append a modifier. type "subdivision": Catmull-Clark subdivision (also switches the mesh to smooth shading unless smooth_shading is false); type "smooth_by_angle": smooth shading that keeps edges folded more than "angle" — and edges marked sharp — crisp. Several subdivisions add their levels up; the last smooth_by_angle decides the shading.',
        inputSchema: {
          ...target,
          type: z.enum(['subdivision', 'smooth_by_angle']).describe('Modifier type'),
          ...settings,
          smooth_shading: z.boolean().optional().describe('add subdivision: also set the mesh to smooth shading (default true)'),
        },
      },
      update: {
        command: 'smooth_update',
        description: 'Change a modifier\'s settings (levels, export_levels, angle, viewport, export).',
        inputSchema: { ...mesh, ...modifier, ...settings },
      },
      remove: {
        command: 'smooth_remove',
        description: 'Delete a modifier from the stack.',
        inputSchema: { ...mesh, ...modifier },
      },
      move: {
        command: 'smooth_move',
        description: 'Move a modifier to another position in the stack.',
        inputSchema: { ...mesh, ...modifier, to: z.number().describe('move: new index, 0 = first') },
      },
      crease: {
        command: 'smooth_crease',
        description: 'Set the subdivision crease of edges: 1 keeps them perfectly sharp, 0.3-0.7 gives a tight rounded bevel, 0 removes the crease. Pick edges with exactly one of edges / angle / selected — e.g. angle 60 creases every hard edge of a box-modeled part. Creased edges show magenta in edit mode.',
        inputSchema: { ...mesh, value: z.number().optional().describe('crease: 0-1 (default 1)'), ...edges },
      },
      sharp: {
        command: 'smooth_sharp',
        description: 'Mark edges sharp for shading (hard normals across them, surface shape unchanged) or clear the mark with sharp: false. Needs an active BlockSmooth modifier to show; add smooth_by_angle with angle 180 to use ONLY marked edges. Pick edges with exactly one of edges / angle / selected.',
        inputSchema: { ...mesh, sharp: z.boolean().optional().describe('sharp: true marks (default), false clears'), ...edges },
      },
      apply: {
        command: 'smooth_apply',
        description: 'Bake the viewport subdivision into the mesh (one undo step): the mesh gets the subdivided vertices and faces, keeps UVs, textures, bone weights, seams and sharp marks; creases keep what is left of their sharpness. The applied subdivision modifiers are removed. Only for editing the dense result — exports already include the modifiers.',
        inputSchema: { ...target },
      },
      shading: {
        command: 'mesh_shading',
        description: 'Blockbench\'s own mesh shading, no plugin needed: "smooth" averages normals across every edge, "flat" shows faceted faces. With a BlockSmooth smooth_by_angle modifier the modifier decides instead.',
        inputSchema: { ...target, shading: z.enum(['flat', 'smooth']).describe('shading: flat or smooth') },
      },
    },
  });
}
