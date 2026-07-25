# Blockbench MCP v1.1 — Design: Pro-Modeling & Fur Support

Date: 2026-07-25 · Builds on `2026-07-25-blockbench-mcp-design.md` (v1.0, 54 tools).
Driven by field feedback from a real modeling session (fox model, reference: Lamostry-style furry Minecraft models).

Requirements came fully specified by the user; this doc records the design decisions made
while implementing them (autonomous session — no interactive design review was possible).

## 1. Offscreen rendering (window-independent screenshots)

Problem: `Screencam.advancedScreenshot` renders through the visible viewport — a minimized
window produces black/stale frames.

Design: `takeScreenshot` renders with a **dedicated cached `THREE.WebGLRenderer`**
(`preserveDrawingBuffer: true, alpha: true`), synchronously (`renderer.render(Canvas.scene, cam)`
inside `Canvas.withoutGizmos`), so no rAF/visibility dependence.

- Angle presets resolve to a direction table (isometric presets are orthographic, like
  Blockbench). Camera auto-fits the model's world bounding sphere (`Box3.expandByObject`
  over visible element meshes) — framing no longer depends on model size.
- `view` preset copies `Preview.selected` camera pose into the offscreen camera.
- Explicit `camera: {position, target, fov, projection}` is used verbatim.
- Any error in the offscreen path falls back to the old `Screencam` path (never worse than v1.0).

## 2. `validate_model`

One call answers "is this model sound, and does anything interpenetrate — now or at time t".

- **Intersections:** every cube pair → OBB corners from `mesh.geometry.boundingBox` × 
  `matrixWorld` → SAT over 15 axes → report pairs with penetration depth > `tolerance`
  (default 0.01 units). Pairs *within the same bone* are skipped by default
  (intra-bone overlap is a deliberate Minecraft technique); `include_same_bone: true` overrides.
  Meshes participate via their local bounding box (documented approximation).
- **Posed validation:** `animation` + `times: [...]` → for each time: select anim, 
  `Timeline.setTime`, `Animator.preview()`, `scene.updateMatrixWorld(true)`, run intersections.
  Reports per-time results. Without `animation`, validates the rest pose (edit mode).
- **Static checks** (each a finding with level error/warning/info): degenerate cubes 
  (≥2 zero axes), unparented cubes in bone-rig formats, untextured faces, per-face UV rects
  out of texture bounds, box-UV unwraps out of bounds, duplicate bone names (bedrock export
  breaks), java_block rotation-limit violations, non-integer texture density. Plus a stats
  block (cubes, faces, bones, max depth, texture sizes).

## 3. `query_geometry` (pose-space world queries)

Returns, at rest or at `animation`+`time` (or several `times`): overall world AABB,
**lowest point** (y + position + element), per-element world AABBs (optional filter),
bone pivot world positions. Multi-time calls return the compact summary per time.
AABBs via `THREE.Box3().expandByObject(element.mesh)` — robust against any rig math.

## 4. Symmetry

- **`mirror_elements`** `{ids, axis: x|y|z (default x), center? (default 0 centered-grid /
  8 legacy-grid), duplicate: false, rename: true}`.
  Cubes: from/to swapped+reflected, origin reflected, rotation [x,-y,-z] for X-mirror
  (sign rules per axis), box-UV `mirror_uv` toggled. Groups recurse; meshes reflect
  vertices and reverse face winding (normals stay outward). `duplicate: true` clones first
  (build left → generate right). `rename` swaps left/right name tokens (left↔right, _l↔_r, …).
- **`add_cubes` gains per-cube `mirror: true`**: also creates the X-mirrored twin; the twin
  parents into the mirrored-name group if one exists (leg_left → leg_right), else same parent.
- **`mirror_keyframes`** `{animation?, mappings?: [{from, to, phase_offset?}], channels?,
  mirror_values: true, replace: true}` — copies bone keyframes to the mirror bone.
  X-symmetry value mapping: rotation [x,-y,-z], position [-x,y,z], scale unchanged.
  Numbers negate; Molang strings wrap as `-(expr)`. `phase_offset` shifts times, wrapping
  modulo animation length (walk cycles: copy left leg → right leg with half-period offset).
  Without `mappings`, auto-pairs bones by left/right name tokens. Bezier handles copied
  with the same value transform; times snap to the animation grid.

## 5. Texture upgrades

- **`create_texture` is now async-correct**: waits for the bitmap to actually load
  (poll ≤3 s), then `Canvas.updateAllFaces` + `updateAllUVs` — reports real dimensions,
  no manual refresh needed afterwards.
- **`paint_faces`**: paint whole cube faces solid colors in one call —
  `{targets: [{element|group, faces: [...]|"all", color, opacity?}]}`. Resolves each face's
  own texture + UV rect; batches edits per texture. Kills the "palette atlas" workaround.
- **`paint_texture` new ops** for fur/organic texturing:
  - `jagged_edge`: pixel-art teeth along one edge of a rect/face — `mode: "erase"` cuts the
    silhouette into transparency (fur tufts on alpha planes), or draws colored teeth.
    Deterministic via `seed`.
  - `noise`: seeded speckle of 1-2 colors in a rect — fur depth/variation.

## 6. Fur geometry: `add_planes`

Zero-thickness cubes (works in every format, exports as standard 0-depth cubes like vanilla
grass/fur planes) with only the two large faces enabled; `double_sided: false` hides the back.
`at` = base-center, `origin` defaults to the base → tilting rotates around the attachment
edge, exactly how fur cards are posed.

- Single planes: ears/cheek tufts/whiskers/tail tip.
- `strips`: a row of overlapping tufts along `from→to` — per-tuft width/height/tilt with
  seeded jitter and alternating tilt; yaw auto-aligns to the strip direction.
  This + `jagged_edge` + alpha texture = the Lamostry-style fur silhouette.

## 7. `add_locators`

Bedrock attachment points (particles/items/leads): batch create with name/parent/position/rotation.

## 8. `eval_code` output upgrades

- Awaits returned promises.
- Returns `data:image/*` results (or `{__image}` / `{__images}`) as real MCP image blocks.
- `result_file`: write the full serialized result to a file; inline reply keeps a preview.
- `max_length` (default 30 000 chars): inline truncation with a pointer to `result_file`.

## 9. Conventions (documented, finally)

Stated in the MCP server `instructions`, in `get_project_info.conventions`, and in the
descriptions of add_cubes/add_groups/set_keyframes:

- Units: 1 = 1/16 block; Y up; +X east, +Z south, −Z north. Entities are modeled facing
  **north (−Z)**; the `north` camera preset shows the front.
- Rotations: degrees, Euler order **ZYX** (X applied first, then Y, then Z — matches
  Minecraft/Bedrock). Sign cheat-sheet: **+X swings a hanging limb forward (toward −Z)**;
  +Y yaws the front toward the east→north direction (CCW from above); +Z rolls the top
  toward west. Keyframe rotation channels use the same convention around the bone pivot.

## Non-goals / rejected

- Reusing Blockbench `flip_x` actions for mirroring — selection-state dependent, no rename
  control, no duplicate mode. Own math is ~60 lines and testable.
- Mesh-based fur primitives — zero-thickness cubes work in *all* formats incl. bedrock.
- Full mesh-accurate intersection (tri-tri) — OBB SAT covers the cube-dominated reality;
  meshes get bounding-box approximation with an explicit note in output.

## Testing

Smoke test (fake plugin) extended tool-count assertion; new live e2e section exercising
every new tool against real Blockbench (fur fox scenario: body + mirrored legs + fur strips
+ jagged alpha texture + walk cycle via mirror_keyframes + validate at t=0..0.5 +
query_geometry ground contact). Not a git repo — no commit step.
