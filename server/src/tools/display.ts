// Display transforms, camera captures, previews and io.
import { z } from 'zod';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forward } from '../respond';
import { vec3, vec2, readOnly, mutating, cameraSchema, anglePresets, registerGroup } from './shared';

export function registerDisplayTools(server: McpServer) {
  registerGroup(server, 'display_transforms', {
    title: 'Item display transforms',
    description: 'How a java_block/bedrock_block item model is displayed in each slot: gui, ground, head, firstperson/thirdperson left/right hand, fixed (item frame), embedded, on_shelf (shelf block).',
    annotations: mutating,
    actions: {
      get: { command: 'get_display_transforms', description: 'Read all configured display slots.' },
      set: {
        command: 'set_display_transforms',
        description: 'Configure one slot. A slot that was never set starts from the game defaults on bedrock_block (Blockbench 5.2), so you can change just one value.',
        inputSchema: {
          slot: z.enum(['thirdperson_righthand', 'thirdperson_lefthand', 'firstperson_righthand', 'firstperson_lefthand', 'ground', 'gui', 'head', 'fixed', 'embedded', 'on_shelf']),
          rotation: vec3().optional(),
          translation: vec3().optional(),
          scale: vec3().optional(),
          mirror: z.array(z.boolean()).length(3).optional(),
        },
      },
    },
  });

  server.registerTool('capture_screenshot', {
    title: 'Screenshot the model',
    description: `Render the current model to an image (offscreen renderer — works even while the Blockbench window is minimized or covered). Use often — after building geometry, texturing, posing. Angle presets: ${anglePresets}; or pass an explicit camera. The camera auto-fits the model bounds for presets.`,
    inputSchema: {
      angle: z.string().optional(),
      camera: cameraSchema.optional(),
      resolution: z.number().optional().describe('Default 960, max 1600'),
      shading: z.boolean().optional().describe('Flat lighting when false'),
      background: z.string().optional().describe('CSS color for an opaque backdrop (default: transparent). Useful to tell "transparent model" apart from "blank image".'),
      include_reference_models: z.boolean().optional().describe('Frame enabled reference models (see preview_models) together with the model — for scale comparisons'),
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
      include_reference_models: z.boolean().optional().describe('Frame enabled reference models too'),
    },
    annotations: readOnly,
  }, forward('capture_multi_view', 120_000));

  server.registerTool('preview_models', {
    title: 'Reference models (player, crafting table, ...)',
    description: 'Show, hide and place Blockbench\'s reference models next to your model — the Minecraft player, the crafting table (new in 5.2), and any others the app has — to judge scale and proportions. Since Blockbench 5.2 they can be moved, rotated and scaled, and the placement is remembered across restarts. They render in capture_screenshot (add include_reference_models: true so the camera frames them). Without "models" it lists them.',
    inputSchema: {
      models: z.array(z.object({
        id: z.string().describe('Model id or name from the list, e.g. "minecraft_player", "minecraft_crafting_table"'),
        enabled: z.boolean().optional().describe('Show (true) or hide (false)'),
        position: vec3().optional().describe('Model units, same space as your model (5.2+)'),
        rotation: vec3().optional().describe('Degrees (5.2+)'),
        scale: z.union([z.number(), vec3()]).optional().describe('Uniform number or [x,y,z] (5.2+)'),
        reset: z.boolean().optional().describe('Back to the default placement'),
      })).optional(),
    },
    annotations: mutating,
  }, forward('preview_models'));

  server.registerTool('reference_images', {
    title: 'Reference images (incl. 3D planes)',
    description: 'Add, move and remove reference images/videos (concept art, blueprints, photos) in the Blockbench viewport. Blockbench 5.2 adds view_mode "plane": the image becomes a panel in the 3D scene that moves with the model — e.g. a side view at plane_position [0, 8, -16] facing the model. Other modes: "flat_image" (overlay fixed to the screen) and "blueprint" (pinned to an orthographic view). NOTE: these are for the USER — they do not show up in capture_screenshot. Without params it lists them.',
    inputSchema: {
      add: z.array(z.object({
        path: z.string().describe('Absolute path to png/jpg/gif/bmp/tiff or mp4/mov/wmv'),
        name: z.string().optional(),
        view_mode: z.enum(['plane', 'flat_image', 'blueprint']).optional().describe('default: "plane" when any plane_* field is given, else "flat_image"'),
        plane_position: vec3().optional().describe('plane: center position in model units'),
        plane_rotation: vec3().optional().describe('plane: rotation in degrees (default faces the front)'),
        plane_size: z.union([z.number(), vec2()]).optional().describe('plane: width in model units (height follows the image) or [width, height]'),
        position: vec2().optional().describe('flat_image/blueprint: screen position in px'),
        size: vec2().optional().describe('flat_image/blueprint: size in px'),
        opacity: z.number().optional().describe('0-1'),
        layer: z.enum(['background', 'viewport', 'float']).optional().describe('Draw behind the model (background, default) or in front'),
        scope: z.enum(['project', 'global']).optional().describe('project (saved in the .bbmodel, default) or global (every project)'),
        cull_backface: z.boolean().optional().describe('plane: hide the back side'),
        clear_mode: z.boolean().optional().describe('Remove the image background color'),
        visible: z.boolean().optional(),
      })).optional(),
      update: z.array(z.object({
        id: z.string().describe('Reference image name or uuid'),
        view_mode: z.enum(['plane', 'flat_image', 'blueprint']).optional(),
        plane_position: vec3().optional(),
        plane_rotation: vec3().optional(),
        plane_size: z.union([z.number(), vec2()]).optional(),
        position: vec2().optional(),
        size: vec2().optional(),
        opacity: z.number().optional(),
        layer: z.enum(['background', 'viewport', 'float']).optional(),
        cull_backface: z.boolean().optional(),
        clear_mode: z.boolean().optional(),
        visible: z.boolean().optional(),
        name: z.string().optional(),
      })).optional(),
      remove: z.array(z.string()).optional().describe('Names/uuids to delete'),
    },
    annotations: mutating,
  }, forward('reference_images'));
}
