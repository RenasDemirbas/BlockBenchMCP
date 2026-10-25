// Status, project creation and settings.
import { z } from 'zod';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forward, toToolResult, errorResult } from '../respond';
import { call, isConnected, getPluginInfo } from '../bridge';
import { headlessEnabled, windowCommand } from '../headless';
import { readOnly, mutating, destructive, registerGroup } from './shared';

export function registerProjectTools(server: McpServer) {
  server.registerTool('get_status', {
    title: 'Get Blockbench status',
    description: 'Check the connection to Blockbench and get the app version, open project tabs, current project, "features" (which Blockbench 5.2 capabilities this install has: texture layer groups, IK poles, movable reference models, 3D reference images, shade direction override, ...) — and "paths": the user\'s home/desktop/temp folders and path separator. Call this first if other tools fail, or whenever you need an absolute path for project_file save/export / render output (get_project_info returns more: last-used folder per file type and recent project paths).',
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    if (!isConnected() && !headlessEnabled) {
      return toToolResult({
        connected: false,
        help: 'Blockbench is not connected. Start Blockbench and make sure the "Blockbench MCP Bridge" plugin is installed and enabled (File > Plugins). It auto-connects within ~3 seconds.',
      });
    }
    try {
      const result = await call('get_status', {});
      return toToolResult({ ...result, ...getPluginInfo(), headless: headlessEnabled || undefined });
    } catch (err) {
      return errorResult(err);
    }
  });

  server.registerTool('blockbench_window', {
    title: 'Show or hide the Blockbench window',
    description: 'Show, hide or check the Blockbench app window (Windows only). Every tool keeps working while it is hidden — screenshots and renders draw offscreen. With the env var BB_HEADLESS=1 the server also starts Blockbench by itself, hidden, when a tool needs it; use "show" when the user wants to look at the model. Works without a plugin connection. Returns window: visible, hidden or none (Blockbench not running).',
    inputSchema: { action: z.enum(['status', 'show', 'hide']) },
    annotations: mutating,
  }, async ({ action }) => {
    try {
      return toToolResult({ window: await windowCommand(action) });
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
    description: 'Create a new Blockbench project. Formats: "bedrock" (Minecraft Bedrock entity with bone animations — the usual choice for animated models), "bedrock_block" (static Bedrock block), "java_block" (Java block/item with display transforms, 22.5° rotation steps), "free" (generic: meshes + animations + bounding boxes, most flexible), "modded_entity", "optifine_entity", "skin". Groups act as animation bones in bone-rig formats.\n\nSKIN / ENTITY TEMPLATES: format "skin" + "skin_model" builds a ready-made Minecraft model with its texture template to paint — steve, alex, cushion (new in 5.2), armor_stand, and every mob (cow, fox, wolf_baby, ...). An unknown id returns the full list.',
    inputSchema: {
      format: z.string().default('bedrock').describe('Format id, see list_formats'),
      name: z.string().optional().describe('Project/model name'),
      model_identifier: z.string().optional().describe('Geometry identifier (bedrock: geometry.<id>)'),
      texture_width: z.number().optional().describe('Texture UV grid width, default 16'),
      texture_height: z.number().optional().describe('Texture UV grid height, default 16'),
      skin_model: z.string().optional().describe('format "skin" only: template id, e.g. "steve", "alex", "cushion", "fox" (default steve)'),
      skin_variant: z.string().optional().describe('format "skin": variant of templates that have several (e.g. tropical fish patterns)'),
      skin_edition: z.enum(['java', 'bedrock']).optional().describe('format "skin": edition for templates that differ between Java and Bedrock'),
      skin_resolution: z.number().optional().describe('format "skin": texture resolution 16/32/64/128 (default: the template\'s own)'),
      skin_pose: z.boolean().optional().describe('format "skin": apply the template\'s default pose (default true)'),
    },
    annotations: mutating,
  }, forward('create_project'));

  server.registerTool('get_project_info', {
    title: 'Get project info',
    description: 'Full orientation snapshot of the current project: format capabilities, texture size, element/bone/texture/animation inventory, open tabs, and "paths" — the project save/export path, the user\'s home/desktop/temp/appdata folders, the folder they last saved each file type to (paths.last_used.model / texture / screenshot / gltf / animation ...) and recent project paths. Use those to build the absolute paths project_file save/export require. Prefer this to orient yourself before editing.',
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
      java_block_version: z.enum(['1.9.0', '1.21.6', '1.21.11', '26.3']).optional().describe('java_block only: 1.21.11+ removes rotation limits; 26.3+ replaces cube "shade" with shade_direction_override (Blockbench 5.2)'),
      bedrock_animation_mode: z.enum(['entity', 'attachable_first']).optional(),
    },
    annotations: mutating,
  }, forward('set_project_settings'));

  registerGroup(server, 'project_file', {
    title: 'Open, save, export, import, switch and close projects',
    description: 'Project files and tabs. Paths must be ABSOLUTE — build them from get_status / get_project_info "paths" (home, desktop, temp, and the folder the user last saved each file type to: paths.last_used.model / gltf / obj / animation ...) — no need to ask.',
    annotations: destructive, // "close" with force discards unsaved changes
    actions: {
      save: {
        command: 'save_project',
        description: 'Save the current project as a .bbmodel (Blockbench native: textures + animations included). "path" is optional if the project was saved before. Use "export" for game-ready formats.',
        inputSchema: { path: z.string().optional().describe('Absolute file path (save: ends in .bbmodel; export: the output file; open/import: the input file)') },
      },
      export: {
        command: 'export_model',
        timeoutMs: 60_000,
        description: 'Export to game/DCC formats without dialogs: bbmodel, bedrock_geo (.geo.json), java_block (.json), gltf, glb, obj (+mtl+textures), fbx, dae, stl, optifine_jem. Textures embed or export alongside depending on format.',
        inputSchema: {
          format: z.enum(['bbmodel', 'bedrock_geo', 'java_block', 'gltf', 'glb', 'obj', 'fbx', 'dae', 'stl', 'optifine_jem']).describe('export: any of these; get_json: bbmodel, bedrock_geo, java_block or gltf'),
          path: z.string(),
          options: z.record(z.string(), z.any()).optional().describe('export codec options, e.g. {scale: 1, embed_textures: true, animations: true} for gltf/glb. Armature rigs: {armature: true} exports skinned meshes; {merge_armature: true} (Blockbench 5.2) merges all meshes of an armature into ONE skinned mesh instead of one per mesh.'),
        },
      },
      export_animations: {
        command: 'export_animations',
        description: 'Export animations to a Bedrock .animation.json file.',
        inputSchema: {
          path: z.string(),
          animations: z.array(z.string()).optional().describe('export_animations: names/uuids (default: all)'),
        },
      },
      get_json: {
        command: 'get_model_json',
        description: 'Return the compiled model file content inline without writing to disk — for inspection.',
        inputSchema: {
          format: z.enum(['bbmodel', 'bedrock_geo', 'java_block', 'gltf']).optional(),
          max_length: z.number().optional().describe('get_json: truncation limit, default 60000 chars'),
        },
      },
      open: {
        command: 'open_project',
        description: 'Open a model file from disk as a new project tab (.bbmodel, bedrock .geo.json, java block .json, .jem, ...).',
        inputSchema: {
          path: z.string(),
          resolve_parents: z.boolean().optional().describe('Java child models (only a "parent", no elements): true (default) merges the whole parent chain into one editable model (Blockbench 5.2); false opens only the child'),
        },
      },
      import: {
        command: 'import_model',
        description: 'Import a model file as a new project tab, or merge a bedrock .geo.json into the current project.',
        inputSchema: {
          path: z.string(),
          merge: z.boolean().optional().describe('import: merge into the current project (bedrock geometry only)'),
          resolve_parents: z.boolean().optional().describe('Java child models (only a "parent", no elements): true (default) merges the whole parent chain into one editable model (Blockbench 5.2); false opens only the child'),
        },
      },
      switch_tab: {
        command: 'select_project_tab',
        description: 'Switch between open project tabs by uuid or name (see get_status).',
        inputSchema: { uuid: z.string().describe('switch_tab: project uuid or display name') },
      },
      close: {
        command: 'close_project',
        description: 'Close the current project tab. Fails if there are unsaved changes unless force is true.',
        inputSchema: { force: z.boolean().optional().describe('close: discard unsaved changes') },
      },
    },
  });
}
