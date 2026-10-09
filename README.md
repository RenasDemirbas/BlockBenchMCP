# Blockbench MCP

An MCP server and a companion Blockbench plugin that let Claude control Blockbench.

With it, Claude builds models, unwraps UVs, paints textures, adds bones and animations, checks the
result with screenshots, and exports the model to any format Blockbench supports. Besides
Minecraft-style cube models, it can make low-poly, hand-painted characters. It can also turn a model
into pixel art sprites for 2D games.

Every change goes into Blockbench's undo history. Press `Ctrl+Z` to revert any step you don't like.

| | |
|---|---|
| **Version** | 1.6.1 · [Changelog](CHANGELOG.md) |
| **Blockbench** | 5.2 or later recommended. 5.1.4 also works, but 5.2-only tools return a "requires 5.2" error there. |
| **Client** | Claude Desktop and Claude Code. Developed on Windows. |
| **Node.js** | 18 or later |
| **Tools** | 82 |

> **If you use version 1.6.0 or older, update.** In older versions, while Blockbench and the MCP server
> were running, any website open in your browser could connect to the bridge and run code on your
> computer. 1.6.1 closes this. Details: [Security](#security).

## What it can do

| Area | Coverage |
|---|---|
| Modeling | Cubes, meshes, planes, locators, bounding boxes. Groups act as bones in animations. `mirror` and `mirror_elements` for symmetric parts. Mesh primitives: plane, pyramid, cylinder, cone, sphere, torus, icosphere, octahedron, dodecahedron. |
| Low-poly | Limbs and tubes from cross-sections (`add_loft`). Extrude, inset, loop cut, bevel, solidify, subdivide (`edit_mesh`). Taper, bend, twist, smooth (`transform_mesh`). |
| Texturing | Template generation, layers and layer groups, gradients, noise, fur strands (`strands`), jagged edges (`jagged_edge`), painting on cube and mesh faces. Light, AO and edge baking (`bake_texture`). Hue-shifted color ramps and palette locking (`palette`). |
| UV | Mesh unwrapping with islands, seams and per-part density (`unwrap_mesh`). Cube UV, auto UV, UV diagnostics (`inspect_uv`). |
| Animation | Keyframes (with Molang expressions), mirrored keyframes, 20 motion presets, effect keyframes, IK with poles, baking IK into plain keyframes. |
| Checking | Screenshots, multi-view captures, animation previews, intersection and ground-contact checks during animation, build timelapse GIF (`record_build`). |
| Reference | Silhouette comparison against a reference image (`compare_reference`), projecting a reference onto the texture (`project_reference`), reference models and 3D reference images in the scene. |
| Export | bbmodel, Bedrock geo.json, Java block, glTF/GLB, OBJ, FBX, DAE, STL, OptiFine JEM, animation JSON. |
| Pixel art | Single frames, 4/8/16-direction sets, sprite sheets with Aseprite JSON. |

### What Blockbench 5.2 adds

5.2 also unlocks: texture layer groups, IK with poles, movable reference models in the scene,
reference images shown as 3D panels, Java 26.3 `shade_direction_override`, the cushion skin template,
Molang `variable_placeholders`, bounding boxes, the `embedded` and `on_shelf` display slots, and glTF
`merge_armature`. The `features` field in the `get_status` output shows which of these your Blockbench
has.

## Installation

### Quick start: prebuilt release

1. Download `blockbench_mcp.js` and `mcp-server.js` from the
   [latest release](https://github.com/RenasDemirbas/BlockBenchMCP/releases/latest). Both are also
   available as a zip. No `npm install` needed: the server is bundled with its dependencies.
2. Put both files in a permanent folder. Blockbench loads the plugin from this path; if you move the
   folder, you have to load the plugin again.
3. [Install the plugin in Blockbench](#install-the-plugin-in-blockbench) and
   [register the server with Claude](#register-with-claude).

### Build from source

```bash
git clone https://github.com/RenasDemirbas/BlockBenchMCP.git
cd BlockBenchMCP
npm install
npm run build
```

The build creates two files in `dist/`:

- `blockbench_mcp.js`: the Blockbench plugin
- `mcp-server.js`: the MCP server (reads its dependencies from `node_modules`)

For a single-file server with dependencies bundled in, run `npm run build:release`.

### Install the plugin in Blockbench

1. Open Blockbench and go to **File → Plugins**.
2. In the top-right menu, choose **Load Plugin from File**.
3. Select `blockbench_mcp.js` and accept the security prompt.

### Register with Claude

**Claude Code:**

```bash
claude mcp add --scope user blockbench -- node /path/to/mcp-server.js
```

**Claude Desktop:** add this to the `mcpServers` section of `%APPDATA%\Claude\claude_desktop_config.json`:

```json
"blockbench": {
  "command": "node",
  "args": ["C:\\path\\to\\mcp-server.js"],
  "env": { "BB_BRIDGE_PORT": "8188" }
}
```

Then fully quit Claude Desktop from the system tray and reopen it.

Both can run at the same time. The first server to take the port becomes the bridge; the others relay
their commands through it.

### Check the connection

With Blockbench open, ask Claude to "check the Blockbench status". `get_status` should return a
connected Blockbench version. If it doesn't, see [Troubleshooting](#troubleshooting).

### Updating

1. Overwrite `blockbench_mcp.js` and `mcp-server.js` with the new files (or `git pull` and
   `npm run build`).
2. Restart Blockbench.
3. Restart Claude Desktop or your Claude Code session. The running server stays on the old version.

`plugin_version` in the `get_status` output should show the new version.

## Recommended workflow

Building the model step by step works better than asking for everything at once. Checking a
screenshot after each step and asking for fixes is less work than fixing everything at the end.

### Cube model (Minecraft-style entity)

1. **Project and skeleton.** Pick a format (`create_project`), then build the bone tree
   (`add_groups`), for example `body > head`, `body > leg_fl`. Animations apply to these groups, so
   don't skip this step.
2. **Geometry.** Place cubes inside the groups (`add_cubes`). Use `mirror: true` for symmetric legs and
   arms. Use `add_planes` for thin parts like fur or leaves.
3. **Check.** Look from the front, side and top with `capture_multi_view`. Fix proportions here;
   changing geometry after painting breaks the UVs.
4. **Texture.** First `generate_texture_template`, then `paint_texture` / `paint_faces`. Without the
   template, many faces share one UV area and painting one repaints the others.
5. **Animation.** `create_animation`, `set_keyframes`, and `mirror_keyframes` for left-right pairs.
   Then use `validate_model` to check for parts intersecting during the animation, and
   `query_geometry` to check that the feet touch the ground.
6. **Export.** `export_model` and `export_animations`. For 2D games, `export_pixel_sprites`.

Example request:

> Make a wolf model in the Bedrock entity format. First build only the skeleton and the shape with gray
> cubes, and show me three views. If I approve, move on to the texture and a walk animation.

### Low-poly, hand-painted character

Recommended order for PS1-style characters with hand-painted textures, in the `free` format:

1. **Reference.** Compare against the reference image from the same angle with `compare_reference`.
   The tool reports silhouette similarity (IoU) and, for each height band, how much wider or narrower
   the model is, in units.
2. **Blockout.** Use `add_loft` for arms, legs, trousers and torso: give the center and size of each
   ring and you get a tapering, bending box limb. Use an `add_mesh_primitive` cylinder for a hat brim,
   and a plane + `edit_mesh` solidify for a cape.
3. **Shaping.** Taper/bend/twist with `transform_mesh`, extrude/inset/loop cut with `edit_mesh`. Steps
   chain with `select: "previous"`, so extrude → inset → extrude happens in one call. Soften boxy parts
   with `bevel`. Run `compare_reference` again after each step.
4. **UV.** `unwrap_mesh {pixel_density: 32-64, density_scale: {"head": 2}}`. Limbs unwrap as single
   strip islands. Pixels painted earlier are carried over to the new layout.
5. **Flat colors.** Pick color ramps with `palette {action: "ramp"}` and fill flat colors with
   `paint_faces`. On meshes, `faces: ["up"]` selects the upward-facing faces. Optionally, project the
   reference onto the texture with `project_reference` as a starting point.
6. **Bake.** `bake_texture {layer: "shading"}` paints light, AO and edge highlights as hue-shifted
   pixel-art steps. It writes to its own layer, so baking again doesn't stack shadows.
7. **Cleanup.** Lock stray colors to the palette with `palette {action: "quantize"}`.
8. **Recording.** Call `record_build {action: "start"}` at the beginning and every edit becomes a
   frame. `stop` at the end writes a part-by-part build GIF.

A ready-made example runs this whole workflow. It builds a four-armed, gas-masked gunslinger and
records the build as a GIF. It works in a new tab and doesn't touch your open model:

```bash
OUT=C:/output/folder node scripts/examples/build-gunslinger.mjs
```

### Coordinate conventions

- 1 unit = 1/16 block. Y is up; the ground is y=0.
- +X is east, -Z is north. Entities are modeled facing north (-Z); the `north` camera preset shows the
  front.
- Rotations are in degrees, order ZYX. +X swings a hanging limb forward.

## Tools

| Area | Tools |
|---|---|
| Project | `get_status`, `list_formats`, `create_project`, `get_project_info`, `set_project_settings`, `open_project`, `save_project`, `select_project_tab`, `close_project` |
| Geometry | `add_groups`, `add_cubes`, `add_meshes`, `add_mesh_primitive`, `add_loft`, `edit_mesh`, `transform_mesh`, `add_planes`, `add_locators`, `add_bounding_boxes`, `list_outline`, `get_element`, `update_elements`, `delete_elements`, `duplicate_elements`, `mirror_elements`, `select_elements` |
| Texture | `create_texture`, `generate_texture_template`, `list_textures`, `get_texture`, `import_texture`, `apply_texture`, `paint_texture`, `paint_faces`, `bake_texture`, `palette`, `texture_layers`, `resize_texture`, `set_texture_resolution`, `delete_texture` |
| UV | `unwrap_mesh`, `set_cube_uv`, `set_mesh_uv`, `auto_uv`, `inspect_uv` |
| Animation | `create_animation`, `list_animations`, `get_animation`, `update_animation`, `delete_animation`, `set_keyframes`, `edit_keyframes`, `mirror_keyframes`, `add_effect_keyframes`, `apply_animation_preset`, `variable_placeholders`, `preview_animation`, `render_animation` |
| IK | `add_ik_controllers`, `bake_ik_animation` |
| Checking | `validate_model`, `query_geometry`, `capture_screenshot`, `capture_multi_view`, `record_build` |
| Reference | `compare_reference`, `project_reference` |
| Scene | `preview_models`, `reference_images` |
| Pixel art | `render_pixel_art`, `export_pixel_sprites`, `pixel_art_presets` |
| Display | `set_display_transforms`, `get_display_transforms` |
| Files | `export_model`, `export_animations`, `import_model`, `get_model_json` |
| Other | `run_action`, `eval_code`, `undo`, `redo` |

Each tool's parameters are described in its MCP schema. Claude reads them on its own.

## Tips

### Texture painting

- `target: {element: "leg_fl", faces: "all"}` paints every cube in a group in one operation. Use
  `element: "*"` for the whole model.
- Give gradients `space: "world"`. Without it, the gradient restarts on every cube and multi-part
  limbs look banded. Use `stops` for multi-stop gradients.
- Painting shadows on a separate layer (`layer`) set to `multiply` at 50% opacity makes them easy to
  adjust later.
- Use `jagged_edge` for fur silhouettes and `strands` for fur texture.
- If the texture looks right as an image but wrong on the model, run `inspect_uv` first. To see a
  single face up close, `get_texture` crops and enlarges that face's UV region.
- If the model looks washed out or shows a grid, the cause is usually not the texture. Check
  Blockbench's `brightness` and `pixel_grid` settings.

### Animation

- Keyframe values can be Molang: `"math.sin(query.anim_time*360)*15"`.
- Times snap to the animation's FPS grid (default 24). Use `snap: false` when you need the exact value.
  Use `edit_keyframes` to retime or delete keyframes later.
- If a bone has a rest rotation, keyframe values are added on top of it; they are not absolute angles.
- For quick motion, `apply_animation_preset`: float, flap, swing, sway, shake, jump, flicker and more.
- Before exporting animations that use IK to Bedrock or Java, convert them to plain rotation keyframes
  with `bake_ik_animation`.

### Pixel art

`render_pixel_art` doesn't produce a downscaled screenshot; it draws the model by pixel art rules.
Scale snaps to texture pixels, there is no anti-aliasing, shading uses a limited number of color
bands, and a 1 px outline is drawn around the silhouette and where parts meet.

- **Views:** `side`, `front`, `back`, `top`, `three_quarter`, `top_down`, `isometric` (2:1),
  `true_isometric`. Use `yaw` / `pitch` for a free angle.
- **Directions:** `directions: 8` produces an eight-direction set. On symmetric models,
  `mirror_directions: true` cuts render time.
- **Style:** `outlined` (default), `clean`, `minecraft`, `flat`.
- **Palette:** the model's own colors by default. Fixed palettes like `pico8`, `sweetie16`,
  `endesga32`, `db32`, or your own hex list also work. Optional Bayer dithering.
- **Sprite sheet:** `export_pixel_sprites` writes animations as a single PNG plus an Aseprite-compatible
  JSON. Scale and pivot are computed once for all frames, so frames don't drift.

Ask Claude for the `pixel_art_presets` output to see every option.

### File paths

Saving and exporting need absolute paths. `get_status` returns the home, desktop and temp folders;
`get_project_info` returns the last-used folder for each file type. Claude builds paths from these.

## How it works

```
Claude ──stdio──► MCP server (mcp-server.js)
                       │  ws://127.0.0.1:8188
                       ▼
             Blockbench plugin (blockbench_mcp.js)
```

The WebSocket server runs on the MCP side and the plugin connects to it, so Blockbench doesn't ask for
network permissions. If Blockbench closes, the server keeps running. When Blockbench reopens, the
plugin reconnects on its own within a few seconds.

Browser engines slow down timers while a window is in the background. The plugin works around this, so
long operations keep running while Blockbench is minimized.

The default port is 8188. To change it, set both the `BB_BRIDGE_PORT` environment variable and
**Settings → General → MCP Bridge Port** in Blockbench to the same value.

## Security

- **The bridge listens only on this computer** (`127.0.0.1`). Other devices on the network can't
  connect.
- **Websites can't connect to the bridge** (1.6.1). The server accepts only connections without an
  Origin header (Node) and the Blockbench window (`file://`), and refuses everything else during the
  handshake. Programs running on your computer can still connect; they already run with your
  permissions, so this adds no extra risk.
- **`eval_code` can't freeze Blockbench.** Node modules that open a permission dialog (`fs`,
  `child_process` and similar) are refused before the code runs. `allow_native_modules: true` opts
  out; the Blockbench window must then be in the foreground.
- **Every change can be undone.** Tools write to Blockbench's undo history.
- **A `.bbmodel` file you share may contain local paths.** Blockbench saves the full path of the
  animation file, which can include your username. Check the file before sharing it.

## Development

```bash
npm run build           # plugin and server
npm run build:release   # single-file server with bundled dependencies (for releases)
npm run typecheck
```

You don't need to restart Blockbench after changing the plugin:

```bash
node scripts/call-tool.mjs eval_code '{"code":"setTimeout(() => Plugins.devReload(), 300); \"ok\"","undo":false}'
```

An open Claude session fixes its tool list when the server starts. To try a new tool without
restarting the session:

```bash
node scripts/call-tool.mjs render_pixel_art '{"view":"isometric","size":64}' --images e2e-output/tmp
```

### Tests

| Script | What it tests | Needs |
|---|---|---|
| `smoke-test.mjs` | MCP protocol and bridge, with a fake plugin | Nothing |
| `verify-bridge-origin.mjs` | The bridge refuses connections from websites | Nothing |
| `e2e-test.mjs` | Full modeling scenario | Open Blockbench |
| `e2e-pro-test.mjs` | Validation, queries, mirroring, painting | Open Blockbench |
| `verify-paint-ops.mjs` | Paint operations | Open Blockbench |
| `verify-field-fixes.mjs` | 1.3 fixes | An open project |
| `verify-v52-features.mjs` | Blockbench 5.2 features | Blockbench 5.2 |
| `verify-pixel-art.mjs` | Pixel art output (PNG and JSON) | Open Blockbench |
| `verify-lowpoly-tools.mjs` | Mesh painting, unwrap, edit/loft/transform, bake, palette, reference, recording. Pick sections with `node scripts/verify-lowpoly-tools.mjs paint,bake` | Open Blockbench, `REF_DIR` for the reference tests |
| `verify-hidden-window-timers.mjs` | Timers while the window is in the background | Minimized Blockbench |

Run any of them with `node scripts/<name>`.

## Troubleshooting

- **"Blockbench is not connected"**
  1. Is Blockbench running?
  2. Is the plugin installed and enabled under **File → Plugins**?
  3. Is the port the same on both sides? (Default 8188.)
- **I updated but the old behavior remains.** Restart the Claude session. The running server process
  keeps using the old file.
- **Long operations time out while the window is in the background.** `timers.unthrottled` in the
  `get_status` output should be `true`. If it's `false`, bring the Blockbench window to the front.
- **Logs**
  - Claude Desktop: `%APPDATA%\Claude\logs\mcp-server-blockbench.log`
  - Blockbench: `Ctrl+Shift+I` → Console → `[MCP]` lines
