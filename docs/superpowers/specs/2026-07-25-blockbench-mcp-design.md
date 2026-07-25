# Blockbench MCP — Design Document

Date: 2026-07-25 · Target: Blockbench **5.1.4** (installed at `%LOCALAPPDATA%\Programs\Blockbench`) · Client: **Claude Desktop (Windows)**

## Goal

A comprehensive MCP server that lets Claude drive Blockbench end-to-end: create projects in any format, build cube/mesh geometry with full group (bone) hierarchies, create and paint textures, map UVs, author **rigged (bone) animations and group-based animations** with full keyframe control (including Molang), configure display transforms, export to every format Blockbench supports, and *see* its work via viewport screenshots — so that high-quality, detailed, animated models can be produced from Claude Desktop prompts alone.

## Architecture (verified against 5.1.4 source)

```
Claude Desktop ──stdio──► MCP server (Node, @modelcontextprotocol/sdk 1.29)
                              │ hosts WebSocket server on ws://127.0.0.1:8090
                              ▼
                    Blockbench plugin (blockbench_mcp.js)
                    connects OUT as a browser WebSocket CLIENT
                    executes commands via window globals (Cube, Group,
                    Animation, Texture, Codecs, Screencam, Undo, …)
```

Why inverted (server hosts, plugin dials out):

1. **Claude Desktop only supports stdio servers** in `claude_desktop_config.json` — no native HTTP. A stdio server is the first-class path (no `mcp-remote`).
2. **Blockbench 5.x deletes `window.require`**; plugins get a permission-gated scoped require where `http`/`ws` are *blocked entirely* and `net` triggers an OS permission dialog. But the renderer's **browser WebSocket client is untouched** — the plugin can dial `ws://127.0.0.1:<port>` with **zero permission prompts**. (This is why jasonjgardner's in-app server needed 627 lines of hand-rolled HTTP-over-`net` plus a permission prompt.)
3. The MCP server outlives Blockbench restarts; the plugin auto-reconnects every 2 s. When Blockbench is closed, tools return actionable errors instead of dying (known pain point of the in-app-server design).

### Protocol (WS, JSON messages)

- Request: `{id, command, params}` · Response: `{id, ok, result | error}`
- Plugin → server on connect: `{event: "hello", blockbench_version, plugin_version}`
- One command in flight at a time (server serializes); 30 s default timeout, 120 s for renders/exports.
- Screenshots travel as base64 PNG data URLs; the plugin renders at the requested resolution (default 960px, capped 1600) so results stay under Claude Desktop's 1 MB tool-result cap.

## Components

- `plugin/src/**` (TypeScript → esbuild IIFE bundle `dist/blockbench_mcp.js`): `Plugin.register('blockbench_mcp', …)`, WS client with reconnect, a command registry (`handlers/` by domain), a `Setting` for the port, a Tools-menu status action. Every mutating handler wraps `Undo.initEdit`/`Undo.finishEdit` with correct aspects so all agent edits are user-undoable.
- `server/src/**` (TypeScript → `dist/mcp-server.js`): McpServer over stdio; `ws` server bound to 127.0.0.1; call correlation with per-request timeouts; ~50 tools with zod raw-shape schemas (flat, no top-level unions — JSON-schema pitfalls from prior art), `readOnlyHint`/`destructiveHint` annotations, in-band `isError` results with recovery guidance; stderr-only logging.
- `scripts/install-plugin.mjs`: builds + copies plugin bundle to a stable path and prints/automates setup; Claude Desktop config snippet written to `%APPDATA%\Claude\claude_desktop_config.json`.

## Tool surface (~50 tools, batched where it matters)

**Project**: `get_status`, `list_formats`, `create_project`, `get_project_info`, `set_project_settings`, `open_project`, `save_project`, `select_project_tab`, `close_project`
**Outliner/geometry**: `add_groups` (batch, bones), `add_cubes` (batch, per-face UV/texture), `add_meshes` (batch, arbitrary polys), `add_mesh_primitive` (sphere/cylinder/cone/torus/plane/pyramid), `list_outline`, `get_element`, `update_elements` (batch), `delete_elements`, `duplicate_elements`, `reparent_elements`, `select_elements`
**Texture/paint**: `create_texture` (blank/color/data), `generate_texture_template` (auto-UV template), `list_textures`, `get_texture` (image), `apply_texture`, `paint_texture` (declarative primitive ops: pixel/line/rect/ellipse/fill/gradient — optionally targeted at a cube face's UV rect in normalized coords), `resize_texture`, `set_texture_resolution`, `import_texture`
**UV**: `set_cube_uv` (per-face + box-UV mode), `set_mesh_uv`, `auto_uv`
**Animation** (differentiator — exact 5.1.4 keyframe API, Molang strings supported): `create_animation`, `list_animations`, `get_animation`, `update_animation`, `delete_animation`, `set_keyframes` (batch per bone/channel; interpolation linear/catmullrom/bezier/step; bezier handles; pre/post data points), `edit_keyframes` (move/scale/set/delete by time range), `add_effect_keyframes` (particle/sound/timeline), `apply_animation_preset` (built-in presets: swing, flap, float, …), `preview_animation` (pose at time t → screenshot), `render_animation` (frame sequence or GIF)
**Display**: `set_display_transforms` (gui/ground/hand slots — java & bedrock block)
**Camera**: `capture_screenshot` (angle presets or explicit camera), `capture_multi_view` (4-view)
**I/O**: `export_model` (bbmodel/bedrock geo/java block/glTF/OBJ/FBX/DAE/STL), `export_animations` (bedrock animation JSON), `import_model`, `get_model_json`
**Escape hatches**: `run_action` (any BarItems id), `eval_code` (raw JS, undo-wrapped), `undo`, `redo`

### Animation semantics ("block-based" vs rigged)

In Blockbench, **Groups are the bones**: `Group.animator = BoneAnimator` — cubes/meshes are animated by putting them in groups and keyframing the group (rotation/position/scale channels). Rigged = deep group hierarchy (+ optional NullObject IK); block-based = shallow groups around cube clusters. Both flow through the same `Animation → getBoneAnimator(group) → addKeyframe` API, which the tools expose directly. The free (generic) format additionally supports Armature/ArmatureBone; bedrock/free formats gate what's allowed and `get_project_info` reports those capability flags to the model.

## Key 5.1.4 API facts the implementation relies on

- Elements: `new Cube({...}).init()`, `new Group({...}).init()`, `addTo(parent)`, `Canvas.updateView({elements, element_aspects})`; **5.x selection**: `Group.first_selected` (NOT 4.x `Group.selected`), `unselectAllElements()`.
- Undo aspects: `{outliner, elements, groups, selection, textures, bitmap, animations, keyframes, uv_mode, display_slots}`.
- Keyframes: `animator.addKeyframe({time, channel, interpolation, data_points:[{x,y,z}]}, uuid?)` — values are Molang strings; snapping via `Timeline.snapTime`.
- Pose for screenshot: `Modes.options.animate.select(); anim.select(); Timeline.setTime(t); Animator.preview();`
- Screenshot: `Screencam.advancedScreenshot(Preview.selected, {angle_preset, resolution, anti_aliasing}, cb)`; custom camera via `Screencam.NoAAPreview` + `Canvas.withoutGizmos`.
- Texture paint: `texture.edit(cb, {edit_name})` → Painter.edit handles undo + `updateChangesAfterEdit`.
- Texture create: `new Texture({name}).fromDataURL(url).add(true)`; templates via `TextureGenerator.addBitmap`.
- Export without dialogs: `codec.compile(options)` (await for gltf!) + `codec.write(content, path)`; `.bbmodel` = `Codecs.project`.
- Project: `newProject(Formats[id])`, `Project.close(true)` for force-close, `ModelProject.all` tabs.
- Plugin loading: file name must equal plugin id; "Load Plugin from File" runs from the original path (one-time manual step), `reload_plugins` action re-reads it.

## Error handling

- Bridge down → `isError` text: "Blockbench is not connected. Open Blockbench and make sure the Blockbench MCP plugin is installed/loaded (File → Plugins)."
- No project open → every geometry tool checks `Project` truthiness first and says to call `create_project`.
- Unknown ids → error names the lookup tool (`list_outline`, `list_textures`, `list_animations`).
- Format capability violations (e.g. meshes in bedrock format) → explicit error with the format's flags.

## Testing

1. Server unit smoke: spawn server, fake-plugin WS client, verify `get_status` round-trip.
2. Live end-to-end: launch Blockbench, load plugin once, then run a scripted battery: create bedrock project → bone hierarchy → cubes → texture + paint → animation with keyframes → screenshot → export geo + animation JSON → verify files.
3. Claude Desktop config installed; user restarts Claude Desktop and connects.
