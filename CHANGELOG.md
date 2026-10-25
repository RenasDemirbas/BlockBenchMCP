# Changelog

## 1.10.1 — Licenses, plugin identity and a documentation site

- The plugin shows the Blockbench MCP logo and "Renas Demirbas" as its author in Blockbench's plugin
  list. The logo is embedded in the plugin file; no separate icon file is needed.
- Both built files start with a copyright and `SPDX-License-Identifier: GPL-3.0-or-later` notice.
- Releases include `LICENSE` and `THIRD_PARTY_LICENSES.txt`, with the license of every npm package
  bundled into `mcp-server.js` (MIT, ISC and BSD require their notices to travel with the code).
  `npm run build:release` writes both; the build moved to `scripts/build.mjs`.
- Documentation site on GitHub Pages: getting started, workflows, recipes, a tool reference generated
  from the server's schemas, the plugin API and troubleshooting.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and pull request templates, and a CI
  workflow (typecheck, release build, protocol and origin tests).

## 1.10.0 — Skinning, materials and a new look

- New tool `add_armature`: builds an armature for skinned meshes ("free" format). Bones are given by
  head and tail points. Meshes passed in `meshes` are attached and skinned right away.
- New tool `vertex_weights` with the actions `auto`, `set`, `smooth`, `normalize`, `clear` and
  `inspect`. `auto` runs Blockbench's Calculate Vertex Weights, then re-solves from distance
  envelopes every vertex it left unweighted or gave to a bone far away (a tube's cap centre used to
  follow the wrong limb). It can also use envelopes only. Weight math always runs on the rest pose.
- `add_ik_controllers`: target and source can be armature bones. Without a source, an armature chain
  starts at the armature's top bone.
- `transform_mesh` `falloff`: proportional editing. Each op except `smooth` also moves the
  vertices within `radius` of the selection, less the further away they are. Curves: smooth, linear,
  sharp, root, constant. Distance is measured in a straight line or along the mesh edges. The
  deformers moved to their own modules; without `falloff` the results are the same as before.
- New tool `generate_pbr_map`: height, normal and MER (metalness, emissive, roughness) maps from a
  colour texture, filed into its material. Built-in presets, plus the presets saved in Blockbench.
  Re-running a MER channel leaves the other two channels as they are.
- New tool `blend_seams`: softens colour breaks across face edges, UV seams and part joints in world
  space. It can write into its own layer.
- `capture_screenshot` `view_mode`: render as `weighted_bone_colors`, `material`, `normal`,
  `wireframe` and so on. The user's view mode is restored afterwards.
- `reference_images`: `video` controls (time, playing, muted, volume) and `sync_to_timeline`. The
  listing shows each video's duration, time and state.
- `edit_keyframes` `relative_to_playhead` (`before` / `after`) with an optional `playhead` time.
- `project_file` open/import `resolve_parents`: a Java child model opens with its whole parent chain
  merged (default) or alone, without the dialog that used to block the call.
- `list_formats` / `get_project_info`: new `pbr` and `molang` capability flags. `get_status`
  features: `armature_ik`, `auto_vertex_weights`, `pbr_materials`, `molang_format_flag`.
- `list_outline` lists armatures and bones with their children. `get_element` shows a bone's head
  in model space and how many vertices it weights, and a mesh's armature.
- Fix: a video reference image added with a custom `name` (no file extension) loaded as an image.
- Fix: screenshots of posed skinned meshes are framed on the posed shape, not the rest pose.
- New test: `scripts/verify-v52-additions.mjs` (45 checks).
- New logo (`assets/`) and a reorganized README.
- License changed from MIT to GPL-3.0-or-later.
- `docs/superpowers` design notes removed from the repository.

## 1.9.0.1 — Detached parts

- `validate_model` finds detached parts: a cube or mesh that does not touch the main body through its
  own, parent, child or sibling bones (a leg floating 1 unit under the torso, a paw beside its leg).
  Each one is listed with its bone, the nearest neighbour and the `[x, y, z]` gap in units, at the rest
  pose or at the given animation times. On by default; `detached: false` turns it off. `tolerance`
  (default 0.01) also sets the largest gap that still counts as touching.
- New test: `scripts/verify-detached.mjs`.

## 1.9.0 — Headless mode

- Headless mode: with `BB_HEADLESS=1` the server starts Blockbench by itself when a tool needs it
  and keeps the window hidden (Windows). See [Headless mode](README.md#headless-mode).
- New tool `blockbench_window`: show, hide or check the Blockbench window. Tools keep working while
  it is hidden.
- New test: `scripts/verify-headless.mjs`.
- Painting a group that holds no cubes or meshes names the groups that do again, with child counts.
- The source is split into smaller modules (the 1500-line tool file, painting, outliner edits). Tools
  behave the same; their schemas are unchanged.
- `add_cubes`, `add_groups`, `add_meshes`, `add_planes`, `add_locators`, `add_bounding_boxes`,
  `add_ik_controllers`, `duplicate_elements` and `mirror_elements` (duplicate): when a batch fails
  partway, nothing it created is left behind. Before, the new nodes survived the rollback and fell out
  of their groups to the root.
- `parent` names now look only at groups, so a cube with the same name as its group (a `floor` cube
  in a `floor` group) no longer makes the name ambiguous.
- `paint_texture`: a `rect` or `ellipse` with only `thickness` draws an outline. `filled` still
  decides when it is given.
- `generate_texture_template` / `unwrap_mesh`: `pixel_density` goes up to 512 (32 px per unit).
  A value out of range is an error; it used to be clamped to 128 without a word.
- New test: `scripts/verify-batch-fixes.mjs`.

## 1.8.0 — Tools from other plugins

- Other Blockbench plugins can add MCP tools with `window.BlockbenchMCP.registerTool(definition, handler)`.
  The tools appear in Claude's tool list as soon as they are registered, also on relay instances,
  and disappear on `delete()` or when Blockbench closes. A `blockbench_mcp_ready` event lets a plugin
  that loaded first, or survived a reload of the bridge plugin, add its tools again. See
  [Adding tools from another plugin](README.md#adding-tools-from-another-plugin).
- New test: `scripts/verify-plugin-api.mjs`.
- Errors thrown by a tool handler no longer carry a stack trace to the model; the Blockbench console
  still logs it.
- `create_texture` / `import_texture`: `force_translucent` (Java block/item, Blockbench 5.2.2+) exports
  the texture as `{"sprite", "force_translucent": true}`. Textures report it, and `get_status`
  features gain `force_translucent_textures`.

## 1.7.1 — Pixel-art parameter descriptions

- `pixel_art`: `animation`, `pose`, `directions` and `mirror_directions` are shared by `render` and
  `export_sheet`, but 1.7.0 showed only the `render` description. `animation` lost the
  "omit for a static sprite" hint for sprite sheets. Each is now defined once with a description
  that covers both actions.
- Grouped tools refuse to start if two actions describe the same parameter differently, so this
  can't happen silently again.

## 1.7.0 — Fewer tools

- Fewer tools (82 → 69): rarely used tools are grouped into one tool with an `action` argument, so
  clients that load every schema up front (Claude Desktop) carry about 9k fewer characters each turn.
  Renamed tools:
  - `project_file`: open, save, export, export_animations, import, get_json, switch_tab, close
    (was `open_project`, `save_project`, `export_model`, `export_animations`, `import_model`,
    `get_model_json`, `select_project_tab`, `close_project`)
  - `uv`: inspect, set_cube, set_mesh, auto (was `inspect_uv`, `set_cube_uv`, `set_mesh_uv`, `auto_uv`)
  - `display_transforms`: get, set (was `get_display_transforms`, `set_display_transforms`)
  - `pixel_art`: render, export_sheet, presets (was `render_pixel_art`, `export_pixel_sprites`,
    `pixel_art_presets`); the shared style options are listed once.
  Each action still checks its own parameters and rejects another action's.
- README, changelog and release notes translated to English.

## 1.6.1 — Security fix

- Security: the bridge now refuses WebSocket connections from browsers. Previously, while Blockbench
  and the MCP server were running, any website could send `eval_code` over `ws://127.0.0.1:8188` and
  run code on the computer. Only connections without an Origin header (Node) and `file://`
  (Blockbench) are accepted. Test: `scripts/verify-bridge-origin.mjs`.
- README rewritten: installing from a release, update steps, Blockbench 5.2 features, a security
  section, the low-poly example build script (`scripts/examples/build-gunslinger.mjs`).
- `npm run build:release`: a single-file server with bundled dependencies. Release files are built
  with it.

## 1.6.0 — Low-poly character tools

- Mesh painting: `paint_texture`, `paint_faces` and `get_texture` now target mesh faces too. The UV
  polygon is clipped pixel-exact, and `space: "world"` gradients are computed per texel. On meshes, a
  direction name (`"up"`) selects every face pointing that way. `inspect_uv` reports mesh UV problems
  and texel density.
- `unwrap_mesh`: connected mesh faces merge into islands. Seam control, per-part density
  (`density_scale`), and existing paint carried over to the new layout.
- `edit_mesh`: Blockbench's extrude, inset, solidify, loop cut, merge, dissolve, create/invert face
  and split tools, plus subdivide, bevel, delete and merge_meshes. Steps chain with
  `select: "previous"`.
- `add_loft`: box, round or custom-profile limbs and tubes from rings. `transform_mesh`: taper, bend,
  twist, scale, rotate, move, smooth, jitter.
- `bake_texture`: light direction, ray-traced ambient occlusion, convex edge highlights and concave
  crease shadows, height gradient and grain. The result snaps to a hue-shifted pixel-art ramp derived
  from each texel's own color.
- `palette`: hue-shifted ramps, color extraction, locking to `auto` / fixed palettes / ramps (with
  dithering).
- `compare_reference`: silhouette IoU against a reference image, aspect ratio and per-band width
  difference, overlay image. `project_reference`: projects the reference onto visible, unoccluded
  texels.
- `record_build`: captures a frame from a fixed camera on every edit and writes an animated GIF at
  the end.
- Fix: `add_mesh_primitive` generated cylinders, cones, pyramids, tori and planes inside out, which
  made extrude go inward. Cylinder and cone caps with more than 4 sides (n-gons) also failed; they are
  now generated as triangle fans.

## 1.5.0 — Pixel art export

- Added `render_pixel_art`, `export_pixel_sprites` and `pixel_art_presets`.
- Texel-aligned orthographic framing (`scale_snap: texel`), 2-4x supersampling and a mode filter. No
  in-between colors; alpha is 0 or 255.
- Cel shading (2-5 bands) and hue shift computed in Oklab: shadows are dark and cool, highlights light
  and warm. Alternatively `shading: blockbench` or `flat`.
- Selective outline (`outline: outer`) and inner lines (`inner_lines: depth+parts`). Inner lines are
  drawn at depth breaks and where two different bones meet.
- Palettes: the model's own colors (`source`), `auto` + `max_colors`, fixed palettes (`pico8`,
  `sweetie16`, `endesga32`, `db32`, `aap64`, `resurrect64`, `apollo`) or a hex list. Optional Bayer
  2/4/8 dithering; outlines are never dithered.
- Cleanup: floating single pixels are removed, the pixel-perfect L rule is applied to outline corners,
  and `alpha_bleed` prevents dark fringes in engines that filter textures.
- Sprite sheet output is compatible with Aseprite hash/array JSON (`frameTags`, pivot `slices`).
  Optional individual frame PNGs and a view-space normal map.

## 1.4.0 — Blockbench 5.2 integration

- `texture_layers`: layers and layer groups. `layer` parameter for `paint_texture` / `paint_faces`.
  Painting now accounts for the layer offset. `resize_texture` scales every layer.
- `add_ik_controllers` (with pole support) and `bake_ik_animation`.
- `preview_models`: movable reference models. `reference_images`: reference images shown as 3D panels
  in the scene.
- `add_mesh_primitive`: `icosphere`, `octahedron`, `dodecahedron`.
- Java 26.3 `shade_direction_override`, cushion skin template, Molang `variable_placeholders`,
  `add_bounding_boxes`, `embedded` / `on_shelf` display slots, glTF `merge_armature`.

## 1.3.0 — Field fixes

- `eval_code` can no longer freeze Blockbench. Blockbench opened a synchronous permission dialog for
  disallowed modules. When the window was minimized the dialog was invisible and the app looked hung.
  Such `require` calls are now refused before the code runs. `allow_native_modules: true` opts out if
  needed.
- `eval_code` accepts top-level `return` and `await`.
- `get_status` and `get_project_info` return file paths and last-used folders.
- Painting a group with no cubes now returns an error listing the groups that do contain cubes. Use
  `element: "*"` for the whole model.
- `set_keyframes` reports times snapped to the FPS grid under `snapped`. Use `snap: false` for exact
  times. Added `edit_keyframes` for retiming and deleting. `update_animation` can now shorten an
  animation.
- If a bone has a rest rotation, `set_keyframes` reports it, because keyframe values are not absolute
  angles but offsets added to the rest rotation.
- `get_texture` can crop and enlarge the UV region of a single face.

## 1.2.0 — Texture painting

- Bulk targeting (`target: {element: "<group>", faces: "all"}`), multi-stop gradients (`stops`),
  `space: "world"`, the `strands` and `noise` ops, `inspect_uv`.
