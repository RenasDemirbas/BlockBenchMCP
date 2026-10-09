#!/usr/bin/env node
// Blockbench MCP server — stdio entrypoint spawned by Claude Desktop.
// stdout is reserved for JSON-RPC; log to stderr only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startBridge } from './bridge';
import { registerTools } from './tools';

const server = new McpServer({
  name: 'blockbench',
  version: '1.7.1',
}, {
  instructions: [
    'Blockbench modeling conventions (Minecraft-style):',
    '- Units: 1 unit = 1/16 block (a standard block is 16x16x16). Y is up; the ground plane is y=0.',
    '- Axes: +X = east, +Z = south, -Z = north. Entities are conventionally modeled facing NORTH (-Z); the "north" camera preset shows the front.',
    '- Rotations: degrees, Euler order ZYX (X applied first — matches Minecraft/Bedrock). +X swings a hanging limb FORWARD (toward -Z); +Y yaws counterclockwise seen from above; +Z rolls the top toward west. Keyframe rotations use the same rules around the bone pivot.',
    '- Groups ARE the animation bones: parent cubes into groups, keyframe the groups.',
    'Typical workflow: create_project → add_groups (bone tree) → add_cubes (use mirror: true for symmetric parts) → add_planes for fur/foliage cards → generate_texture_template → paint_faces / paint_texture (jagged_edge for fur silhouettes) → create_animation → set_keyframes + mirror_keyframes → validate_model (intersections at animation times) + query_geometry (ground contact) → capture_screenshot/render_animation to check → project_file export.',
    'Low-poly hand-painted characters ("free" format): compare_reference against the picture → add_loft for limbs/torso/trousers, add_mesh_primitive for hat brims → transform_mesh (taper/bend) + edit_mesh (extrude/inset/loop_cut/bevel), re-run compare_reference → unwrap_mesh (pixel_density 32-64, density_scale for the head) → palette ramp + paint_faces flat colours (or project_reference) → bake_texture into layer "shading" → palette quantize. record_build start/stop records the build as a GIF.',
    'Texturing notes: generate_texture_template FIRST — without it many faces share one UV rect and painting any of them repaints the rest. paint_texture ops accept "target": {element, faces: "all"} where element may be a group, so one op covers a whole limb. Shade with a multi-stop "gradient"; add "space": "world" so the ramp follows the model\'s Y extent instead of restarting on every cube (otherwise multi-cube limbs look banded). Use the "strands" op for fur grain — its dash count and length scale with each face. When a texture looks right as an image but wrong on the model, run uv action "inspect" before anything else.',
    'A model that renders washed out or covered in a fine grid is usually the viewer\'s own settings, not the texture: Blockbench\'s "brightness" (default 50) and "pixel_grid" (default off) are display-only. get_status reports neither — check them with eval_code on `settings` before repainting.',
    'Animation timing: keyframe times snap to the animation FPS grid ("snapping", default 24), so 0.3s silently becomes 0.29167s and 1.2s becomes 1.20833s — long enough to stretch the clip past its intended length. set_keyframes reports every moved time under "snapped"; pass "snap": false for exact times. edit_keyframes is the retime/delete tool (set_time, time_offset, time_scale, delete, resize_to_content to shorten the clip). Keyframe values are DELTAS on top of a bone\'s rest rotation, not absolute angles.',
    'File paths: never ask the user where to save. get_status returns "paths" (home, desktop, temp, separator) and get_project_info adds the folder they last saved each file type to plus recent project paths — build the absolute paths project_file save/export / eval_code(result_file) need from those.',
    'eval_code must NOT require() Node modules (fs, os, process, child_process, net, https, shell...). Blockbench gates them behind a synchronous native permission modal that freezes the whole app and is invisible while the window is minimised; such calls are refused before the code runs. Use the paths above, Blockbench.writeFile / Blockbench.read, and the PathModule global instead. Top-level `return` and `await` work in eval_code — no IIFE needed.',
    'To read a single face\'s pixels, crop with get_texture {element, face} instead of writing canvas code: it scales that UV rect up to fill max_size.',
    'Pixel art for 2D games: pixel_art action "render" (views: side = model faces right, front, three_quarter = RPG 3/4, isometric = 2:1 pixel iso, top …; "directions": 4/8 for rotation sets; sizes 16/32/64/128) and action "export_sheet" (animation → sprite sheet + Aseprite JSON with a feet pivot, optional per-frame PNGs and a normal-map sheet). They are real pixel art, not downscaled screenshots: texel-aligned orthographic frames, no anti-aliasing, mode-filtered supersampling, cel shading with hue-shifted ramps, selective 1 px outlines, depth inner lines, palette snapping (default: only the model\'s own texture colours). Style presets: outlined (default), clean, minecraft, flat; action "presets" lists everything. Give an absolute "directory" to get files; the inline preview is zoomed.',
    'Blockbench 5.2 features (get_status → "features" says which exist): texture layers & layer groups (texture_layers; paint_texture/paint_faces "layer" keeps shading or details on their own layer), IK with poles (add_ik_controllers: always pass "source"; pole_offset [0,0,-8] bends knees forward; animate the controller\'s position; bake_ik_animation before a Bedrock/Java export), movable reference models (preview_models + capture_screenshot include_reference_models for scale checks), 3D plane reference images (reference_images — for the user, not visible in renders), icosphere/octahedron/dodecahedron primitives, skin templates incl. "cushion" (create_project format "skin" + skin_model), Molang variable placeholders so variable-driven animations preview correctly (variable_placeholders), Java 26.3 shade_direction_override.',
  ].join('\n'),
});

registerTools(server);

async function main() {
  await startBridge();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] Blockbench MCP server running on stdio');
}

main().catch((err) => {
  console.error('[mcp] Fatal error:', err);
  process.exit(1);
});
