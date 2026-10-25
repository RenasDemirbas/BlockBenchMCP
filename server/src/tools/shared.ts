// Schemas, annotations and the action-group helper shared by every tool module.
import { z } from 'zod';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forward, errorResult, type ToolResult } from '../respond';

export const vec3 = () => z.array(z.number()).length(3);
export const vec2 = () => z.array(z.number()).length(2);
export const molangValue = () => z.union([z.number(), z.string()]);
export const vec3molang = () => z.array(molangValue()).length(3).describe('[x, y, z] — numbers or Molang expression strings like "math.sin(query.anim_time*360)*10"');

export const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
export const mutating = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

export const faceKeys = ['north', 'south', 'east', 'west', 'up', 'down'] as const;
// Cube face directions, or mesh face keys — a direction on a mesh picks the faces pointing that way.
export const anyFace = () => z.string().describe('Cube: north/south/east/west/up/down. Mesh: a face key from get_element, or a direction name (= every face whose normal points mostly that way)');
export const cubeFaceSchema = z.object({
  uv: z.array(z.number()).length(4).optional().describe('Face UV rect [x1, y1, x2, y2] in UV units (0..texture UV size). Swap x1/x2 to mirror.'),
  rotation: z.number().optional().describe('UV rotation: 0, 90, 180 or 270'),
  texture: z.string().nullable().optional().describe('Texture name/uuid, or null to hide this face'),
  cullface: z.string().optional().describe('Java block culling: north/south/east/west/up/down or empty'),
  tint: z.number().optional(),
  enabled: z.boolean().optional(),
}).describe('Per-face settings');
export const facesSchema = z.object({
  north: cubeFaceSchema.optional(), south: cubeFaceSchema.optional(),
  east: cubeFaceSchema.optional(), west: cubeFaceSchema.optional(),
  up: cubeFaceSchema.optional(), down: cubeFaceSchema.optional(),
}).describe('Per-face UV/texture settings, keys: north south east west up down');

export const cameraSchema = z.object({
  position: vec3().describe('Camera position [x, y, z]'),
  target: vec3().optional().describe('Look-at point, default [0, 8, 0]'),
  projection: z.enum(['perspective', 'orthographic']).optional(),
  fov: z.number().optional().describe('Field of view in degrees (perspective)'),
}).describe('Explicit camera placement (alternative to angle presets)');

export const anglePresets = 'view (current viewport), initial, top, bottom, north, south, east, west, isometric_right, isometric_left, true_isometric_right, true_isometric_left';

export const shadeDirections = ['', 'north', 'south', 'east', 'west', 'up', 'down'] as const;
export const layerBlendModes = ['default', 'set_opacity', 'color', 'multiply', 'add', 'darken', 'lighten', 'screen', 'overlay', 'difference', 'alpha_mask'] as const;
export const layerParam = () => z.string().optional().describe('Paint into this texture LAYER (name/uuid) instead of the flattened texture. Missing layers are created on top at full texture size, and layers are enabled on the texture if needed — keep shading, details or decals on their own layer, then tune them with texture_layers (opacity, blend mode, visibility).');

// Part of a mesh: face keys / directions / vertices / edges / a slab — or "all" / "previous" (edit_mesh steps).
export const meshSelect = () => z.union([
  z.literal('all'), z.literal('previous'),
  z.object({
    faces: z.union([z.array(z.string()), z.literal('all')]).optional().describe('Face keys (get_element) or direction names'),
    facing: z.union([z.enum(['up', 'down', 'north', 'south', 'east', 'west']), vec3(), z.array(z.enum(['up', 'down', 'north', 'south', 'east', 'west']))]).optional().describe('Faces whose world normal points this way'),
    within: z.number().optional().describe('Angle tolerance for "facing", default 30°'),
    vertices: z.array(z.string()).optional(),
    edges: z.array(z.array(z.string()).length(2)).optional().describe('[[vA, vB], ...]'),
    where: z.object({
      axis: z.enum(['x', 'y', 'z']).optional(), min: z.number().optional(), max: z.number().optional(),
      space: z.enum(['local', 'world']).optional(),
    }).optional().describe('Vertices inside a slab (and faces fully inside it), e.g. {axis:"y", min: 10} = the top part'),
  }),
]);

export interface GroupAction {
  description: string;
  command: string;
  inputSchema?: z.ZodRawShape;
  /** Accepted like inputSchema but not listed per action — the group description explains them once. */
  sharedParams?: z.ZodRawShape;
  timeoutMs?: number;
  handler?: (params: any) => Promise<ToolResult>;
}

/**
 * One tool with an "action" argument for several rarely used commands. A client
 * that loads every schema up front (Claude Desktop) then pays for one schema, and
 * params shared by the actions (pixel-art style options) are listed only once.
 */
export function registerGroup(server: McpServer, name: string, opts: {
  title: string;
  description: string;
  annotations: typeof readOnly | typeof mutating | typeof destructive;
  actions: Record<string, GroupAction>;
}) {
  const shape: z.ZodRawShape = {};
  const lines: string[] = [];
  const merge = (key: string, schema: z.ZodTypeAny) => {
    const prev = shape[key];
    // Only the first definition of a param reaches the client — a later, different description would be silently lost.
    if (prev && schema.description && schema.description !== prev.description) {
      throw new Error(`${name}: param "${key}" is described differently by two actions — share one definition`);
    }
    shape[key] ??= schema.isOptional() ? schema : schema.optional();
  };
  for (const [action, a] of Object.entries(opts.actions)) {
    const params = Object.entries(a.inputSchema ?? {}).map(([key, schema]) => {
      merge(key, schema);
      return schema.isOptional() ? key : `${key}*`;
    });
    for (const [key, schema] of Object.entries(a.sharedParams ?? {})) merge(key, schema);
    if (a.sharedParams) params.push('+ shared params');
    lines.push(`- "${action}": ${a.description}${params.length ? ` Params: ${params.join(', ')}.` : ''}`);
  }
  server.registerTool(name, {
    title: opts.title,
    description: `${opts.description} Actions (* = required):\n${lines.join('\n')}`,
    inputSchema: { action: z.enum(Object.keys(opts.actions) as [string, ...string[]]), ...shape },
    annotations: opts.annotations,
  }, async ({ action, ...params }: any) => {
    const a = opts.actions[action];
    // The merged schema makes every param optional; check this action's own schema (and reject other actions' params).
    const parsed = z.object({ ...a.inputSchema, ...a.sharedParams }).strict().safeParse(params);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ');
      return errorResult(new Error(`${name} action "${action}": ${issues}`));
    }
    return (a.handler ?? forward(a.command, a.timeoutMs))(parsed.data);
  });
}
