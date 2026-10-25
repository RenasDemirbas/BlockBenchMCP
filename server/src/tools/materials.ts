// PBR materials: height / normal / MER maps generated from a colour texture.
import { z } from 'zod';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forward } from '../respond';
import { vec2, mutating } from './shared';

export function registerMaterialTools(server: McpServer) {
  server.registerTool('generate_pbr_map', {
    title: 'Generate PBR maps (height, normal, MER)',
    description: 'Derive PBR maps from a colour texture — Blockbench 5.2\'s "Generate PBR Map" without the dialog, several maps per call. The colour texture is put into a material (texture group) if it is not in one yet, and each map lands in that material: height and normal get their own textures, metalness / emissive / roughness are channels (R / G / B) of one MER texture, so generating "roughness" leaves the metalness already in it alone. Re-running overwrites the same maps.\n\nEach map reads one value per pixel ("method": brightness, value, saturation, hue, red, green, blue, empty), remaps it from in_range to out_range (0-255), optionally inverted. Start from a preset — built-in: height_from_brightness, normal_from_brightness, normal_soft, roughness_matte, roughness_glossy, metal_from_grey, emissive_brightest — and override any field; presets the user saved in Blockbench work by name too ("list_presets": true lists them all).\n\nFormats with PBR: free, bedrock, java_block (Bedrock texture sets, glTF export). Check the look with capture_screenshot {view_mode: "material"}.',
    inputSchema: {
      texture: z.string().optional().describe('Colour texture name/uuid (default: the selected one)'),
      maps: z.array(z.object({
        preset: z.string().optional().describe('Preset name (built-in or saved in Blockbench)'),
        channel: z.enum(['height', 'normal', 'metalness', 'emissive', 'roughness']).optional().describe('Required without a preset'),
        method: z.enum(['brightness', 'value', 'saturation', 'hue', 'red', 'green', 'blue', 'empty']).optional().describe('Default brightness'),
        in_range: vec2().optional().describe('Input values mapped to the output range, default [0, 255]'),
        out_range: vec2().optional().describe('Output range, default [0, 255]'),
        invert: z.boolean().optional(),
        strength: z.number().optional().describe('normal: slope multiplier, default 1'),
      })).optional().describe('Maps to generate, e.g. [{preset: "normal_from_brightness"}, {preset: "roughness_matte"}]. Default: one height map from brightness'),
      list_presets: z.boolean().optional().describe('Only list built-in and saved presets'),
    },
    annotations: mutating,
  }, forward('generate_pbr_map'));
}
