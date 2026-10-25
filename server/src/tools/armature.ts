// Armatures and skinning (Blockbench 5.2, "free" format): bones, mesh
// attachment and vertex weights.
import { z } from 'zod';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forward } from '../respond';
import { vec3, mutating, registerGroup, meshSelect } from './shared';

export function registerArmatureTools(server: McpServer) {
  server.registerTool('add_armature', {
    title: 'Add armature (skeleton for skinned meshes)',
    description: 'Build a skeleton for SKINNED meshes ("free" format): an armature holds bones, and meshes inside it bend smoothly with their bones by vertex weights — one continuous body that deforms at the joints, unlike group bones that move whole parts rigidly. Use groups for blocky Minecraft rigs; use an armature for low-poly characters, tails, tentacles and capes made of one mesh.\n\nBones are given by "head" (start) and "tail" (end) points in model units; children are listed after their parent and may use "connected": true so the parent\'s tail follows them. "meshes" moves existing meshes into the armature (they keep their position) and, unless auto_weights is false, skins them right away (see vertex_weights "auto"). Pass "armature" to add bones or meshes to an existing armature.\n\nAfter: capture_screenshot {view_mode: "weighted_bone_colors"} shows which bone owns which vertex; fix joints with vertex_weights; animate bones with set_keyframes (bone = bone name) or add_ik_controllers (target/source = bone names); export with project_file export gltf/glb {armature: true}.',
    inputSchema: {
      name: z.string().optional().describe('New armature name (default "armature")'),
      armature: z.string().optional().describe('Add to this existing armature instead of creating one'),
      bones: z.array(z.object({
        name: z.string(),
        head: vec3().describe('Start of the bone (the joint it rotates around), model units'),
        tail: vec3().optional().describe('End of the bone; sets its direction and length'),
        parent: z.string().optional().describe('Parent bone (earlier in this list, or an existing one); default: the armature root'),
        length: z.number().optional().describe('Without "tail": length along +Y (default 8)'),
        rotation: vec3().optional().describe('Without "tail": rest rotation in degrees'),
        width: z.number().optional().describe('Display thickness (default 2)'),
        connected: z.boolean().optional().describe('The parent bone\'s tail snaps to this bone\'s head'),
        color: z.number().optional().describe('Marker color index'),
      })).optional(),
      meshes: z.array(z.string()).optional().describe('Meshes to attach (skin) to the armature'),
      auto_weights: z.boolean().optional().describe('Skin attached meshes right away (default true when meshes are given)'),
      weight_method: z.enum(['blockbench', 'envelope']).optional().describe('See vertex_weights "auto"'),
      blend: z.number().optional().describe('envelope: joint blend zone in units (default 2)'),
      max_bones: z.number().optional().describe('envelope: max bones per vertex 1-4 (default 2)'),
    },
    annotations: mutating,
  }, forward('add_armature'));

  const target = {
    mesh: z.string().optional().describe('Skinned mesh name/uuid (default: every mesh in an armature)'),
    meshes: z.array(z.string()).optional().describe('Several skinned meshes'),
  };
  const selection = {
    select: meshSelect().optional().describe('Which vertices (same spec as edit_mesh "select"; default all)'),
    near: z.object({
      bone: z.string(),
      distance: z.number().optional().describe('Units from the bone segment, default 2'),
    }).optional().describe('Narrow the selection to vertices within "distance" of a bone'),
  };

  registerGroup(server, 'vertex_weights', {
    title: 'Vertex weights (skinning)',
    description: 'How strongly each armature bone moves each mesh vertex (0-1 per bone, normally summing to 1). Weights live on the bones, so every edit is one undo step for the whole armature. Weight math runs on the rest pose, so these actions switch Blockbench to Edit mode. Check results with capture_screenshot {view_mode: "weighted_bone_colors"} and by posing a bone (set_keyframes rotation, then capture_screenshot in animate mode).',
    annotations: mutating,
    actions: {
      auto: {
        command: 'weights_auto',
        description: 'Skin meshes to their armature from scratch (replaces existing weights). method "blockbench" (default) runs Blockbench 5.2\'s Calculate Vertex Weights (works from edge loops; best on limb-like topology) and re-solves from distance envelopes any vertex it leaves out or hands to a bone far away (reported as repaired_by_envelope); "envelope" uses distance to each bone only: each vertex follows its nearest bone and blends with others within "blend" units (soft joints), up to max_bones.',
        inputSchema: {
          ...target,
          method: z.enum(['blockbench', 'envelope']).optional(),
          blend: z.number().optional().describe('auto envelope: joint blend zone in units, default 2'),
          max_bones: z.number().optional().describe('auto envelope: bones per vertex 1-4, default 2'),
        },
      },
      set: {
        command: 'weights_set',
        description: 'Paint a weight onto selected vertices for one bone. mode: "replace" (default — the vertices follow ONLY this bone at "weight", like Blockbench\'s Set Vertex Weights with overwrite), "mix" (this bone gets "weight", the others share the rest in their old ratio — keeps sums at 1), "add"/"subtract" (change this bone\'s weight, then normalize).',
        inputSchema: {
          mesh: z.string().optional().describe('Skinned mesh name/uuid (default: every mesh in an armature)'),
          bone: z.string().describe('set: bone name/uuid; clear: only this bone (default all)'),
          weight: z.number().optional().describe('set: 0-1, default 1'),
          mode: z.enum(['replace', 'mix', 'add', 'subtract']).optional(),
        },
        sharedParams: selection,
      },
      smooth: {
        command: 'weights_smooth',
        description: 'Average weights with neighbouring vertices — softens a joint that creases or tears when bent. factor 0-1 (default 0.5) per iteration (default 2).',
        inputSchema: {
          ...target,
          factor: z.number().optional().describe('smooth: 0-1, default 0.5'),
          iterations: z.number().optional().describe('smooth: 1-20, default 2'),
        },
        sharedParams: selection,
      },
      normalize: {
        command: 'weights_normalize',
        description: 'Rescale every vertex\'s weights to sum to 1.',
        inputSchema: { ...target },
      },
      clear: {
        command: 'weights_clear',
        description: 'Remove weights from selected vertices — all bones, or only "bone".',
        inputSchema: { ...target, bone: z.string().optional().describe('set: bone name/uuid; clear: only this bone (default all)') },
        sharedParams: selection,
      },
      inspect: {
        command: 'weights_inspect',
        description: 'Per mesh: vertices per bone with their average weight, the most bones on one vertex, and vertices that follow no bone (with positions) or do not sum to 1.',
        inputSchema: { ...target },
      },
    },
  });
}
