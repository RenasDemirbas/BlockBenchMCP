// Pixel-art sprite rendering.
import { z } from 'zod';
import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toToolResult, errorResult, type ToolResult } from '../respond';
import { call } from '../bridge';
import { vec3, vec2, mutating, registerGroup } from './shared';

export function registerPixelArtTools(server: McpServer) {
  const pixelViewNames = 'side (model faces right — platformer), left, front, back, top, bottom, three_quarter / rpg (front tilted 30°), top_down (60°), side_three_quarter, isometric / isometric_right (2:1 pixel iso, 30° elevation, from the north-west), isometric_left, true_isometric, true_isometric_left';
  const pixelStyleSchema = {
    size: z.union([z.number(), vec2()]).optional().describe('Frame size in pixels: 16, 32, 64, 128, 256 or [width, height]. Default 32. The model is auto-fitted (see pixels_per_unit).'),
    pixels_per_unit: z.number().optional().describe('Explicit scale (pixels per model unit; 1 = a 16-unit block is 16 px). Default: auto-fit the model into the frame, snapped so 1 texel = a whole number of pixels ("scale_snap"). Set it yourself to keep several models/animations at the same scale.'),
    scale_snap: z.enum(['texel', 'integer', 'half', 'none']).optional().describe('How the auto-fitted scale is rounded: texel (default — whole pixels per texture pixel, the crisp choice), integer, half, none'),
    padding: z.number().optional().describe('Empty pixels kept around the sprite inside the frame (default 1 — needed for an outer outline)'),
    anchor: z.enum(['auto', 'origin', 'bounds', 'center']).optional().describe('Frame placement: origin = model origin at the horizontal centre with the lowest point on the bottom padding line (characters: pivot at the feet); bounds = centre the bounds horizontally, feet down; center = centred both ways (icons); auto (default) = origin when the origin is inside the model, else bounds'),
    supersample: z.number().optional().describe('Internal supersampling factor 1-8 (default 4 for ≤64 px, 3 for ≤128, 2 above). Each output pixel takes the MOST FREQUENT colour among its samples (no averaging), so no blended colours appear.'),
    sampling: z.enum(['mode', 'center']).optional().describe('mode (default): most frequent colour per pixel; center: the sample nearest the pixel centre (= rendering at native size)'),
    alpha_threshold: z.number().optional().describe('Coverage needed for an opaque pixel, 0.05-1 (default 0.5). Lower keeps thin planes (fur, whiskers) alive.'),
    style: z.enum(['outlined', 'clean', 'minecraft', 'flat']).optional().describe('Preset: outlined (default) = toon shading + selective outer outline + depth & part inner lines; clean = toon shading only; minecraft = Blockbench face shading, no outline; flat = texture colours only. Individual options below override the preset.'),
    shading: z.enum(['toon', 'blockbench', 'flat']).optional().describe('toon: cel bands from a fixed top-left light with hue-shifted ramps (shadows darker+cooler+more saturated, highlights lighter+warmer); blockbench: the app\'s face shading (top 100%, N/S 80%, E/W 60%, bottom 50%); flat: no lighting'),
    shade_levels: z.number().optional().describe('Toon bands 1-5 (default 2 for ≤16 px, 3 for ≤48 px, 4 above): shadow / base / highlight …'),
    light: vec3().optional().describe('Toon light direction in screen terms: x = image right, y = up, z = toward the camera. Default [-0.35, 0.75, 0.45] = top-left-front. It follows the camera yaw (every direction of a set is lit from the screen\'s top-left) but not the pitch.'),
    ramp: z.object({
      step: z.number().optional().describe('Oklab lightness per shade step (default 0.13)'),
      hue_shift: z.number().optional().describe('Degrees of hue rotation per step (default 15)'),
      shadow_hue: z.number().optional().describe('Hue shadows drift toward (default 270 = blue-violet)'),
      highlight_hue: z.number().optional().describe('Hue highlights drift toward (default 90 = yellow)'),
      shadow_chroma: z.number().optional().describe('Chroma added per shadow step (default 0.02)'),
      highlight_chroma: z.number().optional().describe('Chroma removed per highlight step (default 0.03)'),
    }).optional().describe('Hue-shifting ramp parameters for toon shading, outlines and inner lines'),
    outline: z.enum(['none', 'outer', 'inner']).optional().describe('outer: 1 px line around the silhouette (grows the sprite; keep padding ≥ 1); inner: recolour the border pixels; none'),
    outline_color: z.string().optional().describe('"auto" (default): selective outline — 2-3 shade steps darker/cooler than the neighbouring fill, lighter on the lit top-left edge, darkest on the bottom-right; or a hex colour like "#1a1c2c"'),
    outline_connectivity: z.number().optional().describe('4 (default — pixel-art corners connect diagonally) or 8 (fatter, filled corners)'),
    inner_lines: z.string().optional().describe('Dark 1 px inner lines, combined with "+": "depth" (a nearer part occludes a farther one), "parts" (where two different BONES meet, even flush — separates arms from a torso, head from neck), "normal" (sharp creases); "all"; "none". Default "depth+parts" for the outlined style.'),
    line_depth_threshold: z.number().optional().describe('Depth jump (model units) that counts as an inner line. Default max(1.5, 2.5 / pixels_per_unit).'),
    line_side: z.enum(['near', 'far']).optional().describe('Draw the inner line on the nearer (default, hand-drawn look) or the farther surface'),
    line_color: z.string().optional().describe('"auto" (one shade step darker, default) or a hex colour'),
    palette: z.union([z.string(), z.array(z.string())]).optional().describe('source (default): only the model\'s own texture colours and their shade-ramp variants may appear; auto: median-cut/k-means in Oklab down to max_colors; none: keep whatever the shading produced; a built-in palette name — pico8, sweetie16, endesga32, db32, aap64, resurrect64, apollo; or an array of hex colours. Nearest colours are matched perceptually (Oklab).'),
    max_colors: z.number().optional().describe('For palette "auto" (default 12 for ≤16 px, 24 for ≤32, 40 for ≤64, 64 above)'),
    dither: z.enum(['none', 'bayer2', 'bayer4', 'bayer8']).optional().describe('Ordered (Bayer) dithering when snapping to a fixed/auto palette. Default none — sprites are usually better without; bayer4 at 0.25-0.5 for gradients. Outlines are never dithered.'),
    dither_strength: z.number().optional().describe('0-1, default 0.5'),
    cleanup: z.enum(['none', 'specks', 'despeckle']).optional().describe('specks (default): drop floating single pixels; despeckle: also recolour lone pixels that have no same-coloured neighbour (kills 1 px eyes too); none'),
    pixel_perfect: z.boolean().optional().describe('Remove the middle pixel of L-shaped outline corners so diagonals connect corner-to-corner (default true, outline pixels only)'),
    alpha_bleed: z.boolean().optional().describe('Copy edge colours into the transparent pixels around the sprite (alpha stays 0) so engines that filter never show dark fringes. Default true.'),
    background: z.string().optional().describe('Hex colour for an opaque background (default transparent)'),
    include_reference_models: z.boolean().optional().describe('Render enabled reference models (player, crafting table) too. Default false.'),
    preview_scale: z.number().optional().describe('Zoom factor of the inline preview image (default: auto so it is readable)'),
  };

  /** Create the output folder on this side (plain Node) — the plugin cannot mkdir without a permission modal. */
  const forwardWithDirectory = (command: string, timeoutMs: number) => async (params: any): Promise<ToolResult> => {
    try {
      const dir = params?.output?.directory ?? params?.directory;
      if (dir != null) {
        if (typeof dir !== 'string' || !isAbsolute(dir)) {
          return errorResult(new Error(`"directory" must be an absolute path (got ${JSON.stringify(dir)}). get_status returns "paths" (desktop, home, temp) to build one from.`));
        }
        mkdirSync(dir, { recursive: true });
      }
      const result = await call(command, params ?? {}, timeoutMs);
      return toToolResult(result);
    } catch (err) {
      return errorResult(err);
    }
  };

  /** Camera and pose params that render and export_sheet both take — one definition so neither description is lost. */
  const pixelPoseSchema = {
    view: z.string().optional().describe(`View preset (default "side"): ${pixelViewNames}`),
    yaw: z.number().optional().describe('Camera azimuth override in degrees (0 = looking at the front, 90 = model faces right, 180 = back, 270 = model faces left)'),
    pitch: z.number().optional().describe('Camera elevation override in degrees (0 = straight on, 30 = pixel iso / 3/4, 90 = top)'),
    directions: z.number().optional().describe('Rotation set: 4, 8 or 16 yaws starting at the view\'s yaw. 1 = just the view (default).'),
    mirror_directions: z.boolean().optional().describe('Render only the right-facing half of the set and mirror the rest (symmetric models only)'),
    animation: z.string().optional().describe('Animation name/uuid. render: pose the model at "time" (default: rest pose). export_sheet: the animation to sample — omit for a static sprite.'),
    pose: z.enum(['rest', 'current']).optional().describe('Without "animation" (static sprite): rest = bind pose (default), current = whatever pose the viewport/timeline shows'),
  };

  registerGroup(server, 'pixel_art', {
    title: 'Pixel-art sprites and sprite sheets',
    description: `Render the model as GENUINE pixel art for 2D games — not a downscaled screenshot. Pixel-aligned orthographic frame (1 texel = whole pixels, origin on a pixel corner), no anti-aliasing, mode-filtered supersampling (no blended colours), cel shading with hue-shifted ramps, selective 1 px outline, depth inner lines, palette snapping in Oklab, binary alpha, cleanup. Views: ${pixelViewNames}; or "yaw"/"pitch" (camera azimuth 0 = front, 90 = the model faces right; elevation 0-90). Rotation sets via "directions" (4/8/16 — names: down, down_right, right, up_right, up, up_left, left, down_left = the way the model faces on screen). Frame sizes 16/32/64/128/256. Shared params (render + export_sheet): size … preview_scale — frame size, scale, style preset, shading, outline, inner lines, palette, dither, cleanup.`,
    annotations: mutating, // writes PNGs when a directory is given
    actions: {
      render: {
        command: 'render_pixel_art',
        handler: forwardWithDirectory('render_pixel_art', 180_000),
        description: 'Still sprite(s): one view, several presets via "views", or a rotation set. Returns one contact-strip preview image (zoomed) and, with "directory", writes the true-size PNGs.',
        sharedParams: pixelStyleSchema,
        inputSchema: {
          ...pixelPoseSchema,
          views: z.array(z.string()).optional().describe('render: several presets in one call (e.g. ["side", "front", "three_quarter", "isometric"])'),
          time: z.number().optional().describe('render: seconds into "animation"'),
          directory: z.string().optional().describe('Absolute folder to write <name>_<view>.png at true size (created if missing)'),
          name: z.string().optional().describe('File base name (default: project name)'),
          normal_map: z.boolean().optional().describe('Also write <name>_<view>_normal.png (view-space normals) for engines that light sprites'),
        },
      },
      export_sheet: {
        command: 'export_pixel_sprites',
        handler: forwardWithDirectory('export_pixel_sprites', 600_000),
        description: 'Render an animation (or several, or the static model) — optionally as a 4/8-direction set — into a pixel-art SPRITE SHEET with Aseprite-compatible JSON (frames with durations, frameTags per animation/direction, a "pivot" slice at the model origin = feet, plus a "pixelart" block with pixels_per_unit, directions and frame pivots), optional per-frame PNGs and a normal-map sheet. One scale and one pivot for the whole set (bounds are unioned over every pose and direction) so frames never jump. Frames are sampled at "fps" (default 12): a looping 1 s animation gives 12 frames. Rows: one per animation/direction, or a grid via output.columns. Returns a zoomed preview of the sheet.',
        sharedParams: pixelStyleSchema,
        inputSchema: {
          ...pixelPoseSchema,
          animations: z.array(z.string()).optional().describe('export_sheet: several animations in one sheet (each becomes a frame tag / row group)'),
          fps: z.number().optional().describe('export_sheet: frames per second to sample (default 12). Sets the frame durations in the JSON.'),
          frames: z.number().optional().describe('export_sheet: exact frame count per animation (overrides fps sampling; spread evenly over the length)'),
          times: z.array(z.number()).optional().describe('export_sheet: explicit times in seconds (single animation only)'),
          output: z.object({
            directory: z.string().optional().describe('Absolute folder (created if missing). Without it nothing is written — only the preview comes back.'),
            name: z.string().optional().describe('Base file name (default: <project>_<animation>)'),
            sheet: z.boolean().optional().describe('Write <name>.png (default true)'),
            json: z.union([z.enum(['hash', 'array', 'none']), z.boolean()]).optional().describe('Aseprite JSON format: hash (default), array, or none'),
            frames: z.boolean().optional().describe('Also write every frame as <name>_<tag>_<index>.png next to the sheet (default false)'),
            normal_map: z.boolean().optional().describe('Also write <name>_normal.png, a matching sheet of view-space normals (default false)'),
            columns: z.number().optional().describe('Force a grid with this many columns instead of one row per animation/direction'),
            padding: z.number().optional().describe('Transparent pixels between cells (default 1)'),
            margin: z.number().optional().describe('Transparent border around the sheet (default 0)'),
            extrude: z.number().optional().describe('Replicate each cell\'s edge pixels outward by N px to stop atlas bleeding (default 0)'),
            pot: z.boolean().optional().describe('Pad the sheet to power-of-two dimensions'),
            preview_file: z.boolean().optional().describe('Also write a zoomed <name>_preview.png'),
          }).optional(),
        },
      },
      presets: {
        command: 'pixel_art_presets',
        description: 'List the view presets (with camera angles), style presets, built-in palettes, direction names and default values.',
      },
    },
  });
}
