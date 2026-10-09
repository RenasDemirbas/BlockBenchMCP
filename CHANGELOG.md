# Changelog

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
