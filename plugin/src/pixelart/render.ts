// Offscreen multi-pass renderer for pixel art. Every frame is rendered
// supersampled (no MSAA, nearest textures) in three passes — flat albedo,
// Blockbench face shading, and packed view-space normal + depth — and then
// collapsed to the target size with a coverage threshold and a MODE filter:
// each output pixel takes the most frequent colour among its covered samples
// instead of an average, so no blended "in-between" colours are invented and
// thin geometry survives as long as it covers enough of the pixel.
import { renderableElements, ViewBasis, FrameSpec, ViewBounds, buildOrthoCamera } from './camera';

export interface PixelBuffers {
  width: number;
  height: number;
  /** 0 or 255 per pixel. */
  alpha: Uint8Array;
  /** Flat texel colours, 3 bytes per pixel. */
  albedo: Uint8ClampedArray;
  /** Blockbench face-shaded colours, 3 bytes per pixel. */
  lit: Uint8ClampedArray;
  /** View-space normal, 3 floats per pixel (z toward the camera). */
  normal: Float32Array;
  /** Depth along the view direction in model units (smaller = closer). */
  depth: Float32Array;
  /** Fraction of supersamples that were covered (0..1). */
  coverage: Float32Array;
  /** Part id per pixel (1-based index of the element's bone; 0 = none). */
  part: Uint32Array;
}

export interface RenderPassOptions {
  supersample: number;
  alpha_threshold: number;
  sampling: 'mode' | 'center';
  include_reference_models: boolean;
  /** Extra scene objects (reference models) that take part in the geometry pass. */
  extra_objects?: any[];
}

// ───────────────────────────── renderer ─────────────────────────────

type Ctx = {
  renderer: any;
  canvas: any;
  rt: any;
  w: number;
  h: number;
};

let ctx: Ctx | null = null;

function getContext(w: number, h: number): Ctx {
  if (ctx && ctx.renderer.getContext()?.isContextLost?.()) {
    try { ctx.rt.dispose(); ctx.renderer.dispose(); } catch { /* ignore */ }
    ctx = null;
  }
  if (!ctx) {
    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,           // pixel art: no MSAA, we supersample ourselves
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(1);
    renderer.autoClear = true;
    renderer.sortObjects = true;
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    ctx = { renderer, canvas, rt, w, h };
  }
  if (ctx.w !== w || ctx.h !== h) {
    ctx.renderer.setSize(w, h, false);
    ctx.rt.setSize(w, h);
    ctx.w = w; ctx.h = h;
  }
  return ctx;
}

export function disposePixelRenderer() {
  if (!ctx) return;
  try { ctx.rt.dispose(); ctx.renderer.dispose(); } catch { /* ignore */ }
  ctx = null;
}

// ───────────────────────────── geometry pass materials ─────────────────────────────

const GEO_VERT = `
varying vec3 vNormal; varying vec2 vUv; varying float vDepth;
void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const GEO_FRAG = `
precision highp float;
uniform sampler2D map; uniform float hasMap; uniform float depthNear; uniform float depthFar;
varying vec3 vNormal; varying vec2 vUv; varying float vDepth;
void main() {
  if (hasMap > 0.5) {
    vec4 c = texture2D(map, vUv);
    if (c.a < 0.01) discard;
  }
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  float d = clamp((vDepth - depthNear) / max(depthFar - depthNear, 1e-4), 0.0, 1.0);
  float scaled = d * 255.0;
  float hi = floor(scaled) / 255.0;
  float lo = fract(scaled);
  gl_FragColor = vec4(n.x * 0.5 + 0.5, n.y * 0.5 + 0.5, hi, lo);
}`;

const geoMaterials = new WeakMap<any, any>();

function mapOf(material: any): any {
  return material?.uniforms?.map?.value ?? material?.uniforms?.t0?.value ?? material?.map ?? null;
}

// ID pass: every mesh writes a flat colour encoding its part id, so the
// processor can draw a line wherever two different bones meet even when they
// are flush (arms against a torso) — the ID-buffer outline of ProPixelizer.
const ID_FRAG = `
precision highp float;
uniform sampler2D map; uniform float hasMap; uniform vec3 idColor;
varying vec2 vUv;
void main() {
  if (hasMap > 0.5) {
    vec4 c = texture2D(map, vUv);
    if (c.a < 0.01) discard;
  }
  gl_FragColor = vec4(idColor, 1.0);
}`;
const ID_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const idMaterials = new WeakMap<any, any>();

function idMaterialFor(original: any, id: number): any {
  if (!original) return original;
  let mat = idMaterials.get(original);
  const map = mapOf(original);
  if (!mat) {
    mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, hasMap: { value: map ? 1 : 0 }, idColor: { value: new THREE.Vector3() } },
      vertexShader: ID_VERT,
      fragmentShader: ID_FRAG,
      side: original.side ?? THREE.FrontSide,
      transparent: false,
      blending: THREE.NoBlending,
      depthTest: true,
      depthWrite: true,
    });
    idMaterials.set(original, mat);
  }
  if (mat.uniforms.map.value !== map) { mat.uniforms.map.value = map; mat.uniforms.hasMap.value = map ? 1 : 0; }
  // Materials are shared between elements, so the id is set per mesh right
  // before its draw call via onBeforeRender (see renderPixelFrame).
  mat.side = original.side ?? THREE.FrontSide;
  mat.visible = original.visible !== false;
  return mat;
}

/** Bone that owns an element: its parent group, or the element itself at the top level. */
export function partKeyOf(el: any): string {
  const parent = el.parent;
  return parent && parent !== 'root' && parent.uuid ? parent.uuid : el.uuid;
}

function geoMaterialFor(original: any, depthNear: number, depthFar: number): any {
  if (!original) return original;
  let mat = geoMaterials.get(original);
  const map = mapOf(original);
  if (!mat) {
    mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: map },
        hasMap: { value: map ? 1 : 0 },
        depthNear: { value: depthNear },
        depthFar: { value: depthFar },
      },
      vertexShader: GEO_VERT,
      fragmentShader: GEO_FRAG,
      side: original.side ?? THREE.FrontSide,
      transparent: false,
      blending: THREE.NoBlending,
      depthTest: true,
      depthWrite: true,
    });
    geoMaterials.set(original, mat);
  }
  if (mat.uniforms.map.value !== map) {
    mat.uniforms.map.value = map;
    mat.uniforms.hasMap.value = map ? 1 : 0;
  }
  mat.uniforms.depthNear.value = depthNear;
  mat.uniforms.depthFar.value = depthFar;
  mat.side = original.side ?? THREE.FrontSide;
  mat.visible = original.visible !== false;
  return mat;
}

// ───────────────────────────── unlit materials for reference models ─────────────────────────────

// Reference models (player, crafting table …) use MeshLambert/MeshBasic
// materials lit by the scene lights, not Blockbench's SHADE shader, so the
// albedo pass swaps them for an unlit twin that returns exact texel colours.
const unlitMaterials = new WeakMap<any, any>();

function unlitMaterialFor(original: any): any {
  if (!original || original.isShaderMaterial) return original;
  let mat = unlitMaterials.get(original);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      map: original.map ?? null,
      color: original.color ? original.color.clone() : 0xffffff,
      side: original.side ?? THREE.FrontSide,
      alphaTest: original.alphaTest ?? 0.01,
      transparent: original.transparent ?? false,
    });
    unlitMaterials.set(original, mat);
  }
  if (mat.map !== (original.map ?? null)) { mat.map = original.map ?? null; mat.needsUpdate = true; }
  if (original.color) mat.color.copy(original.color);
  mat.side = original.side ?? THREE.FrontSide;
  mat.visible = original.visible !== false;
  return mat;
}

// ───────────────────────────── shading uniforms ─────────────────────────────

/** Every Blockbench material whose SHADE/brightness uniforms affect the render. */
function shadedMaterials(): any[] {
  const out: any[] = [];
  const push = (m: any) => { if (m && m.uniforms && !out.includes(m)) out.push(m); };
  for (const tex of Texture.all) {
    try { push(tex.getOwnMaterial?.()); } catch { /* ignore */ }
    try { push(tex.getMaterial?.()); } catch { /* ignore */ }
  }
  (Canvas.emptyMaterials || []).forEach(push);
  (Canvas.coloredSolidMaterials || []).forEach(push);
  push(Canvas.monochromaticSolidMaterial);
  push(Canvas.layered_material);
  return out;
}

function withShading(shade: boolean, fn: () => void) {
  const mats = shadedMaterials();
  const saved = mats.map((m) => ({
    m,
    shade: m.uniforms.SHADE?.value,
    light: m.uniforms.LIGHTCOLOR?.value?.clone?.(),
    brightness: m.uniforms.BRIGHTNESS?.value,
  }));
  for (const m of mats) {
    if (m.uniforms.SHADE) m.uniforms.SHADE.value = shade;
    // Color.set() takes ONE argument (a hex/style) — setRGB is the 3-channel form.
    if (m.uniforms.LIGHTCOLOR?.value?.setRGB) m.uniforms.LIGHTCOLOR.value.setRGB(1, 1, 1);
    if (m.uniforms.BRIGHTNESS) m.uniforms.BRIGHTNESS.value = 1;
  }
  try {
    fn();
  } finally {
    for (const s of saved) {
      if (s.m.uniforms.SHADE && s.shade !== undefined) s.m.uniforms.SHADE.value = s.shade;
      if (s.light && s.m.uniforms.LIGHTCOLOR?.value?.copy) s.m.uniforms.LIGHTCOLOR.value.copy(s.light);
      if (s.m.uniforms.BRIGHTNESS && s.brightness !== undefined) s.m.uniforms.BRIGHTNESS.value = s.brightness;
    }
  }
}

// ───────────────────────────── scene housekeeping ─────────────────────────────

const NON_RENDERED_TYPES = new Set(['locator', 'null_object', 'bounding_box', 'armature', 'armature_bone']);

/** Hide helpers that are not part of the sprite (locators, reference models, selection highlight). */
function withCleanScene(includeReferenceModels: boolean, fn: () => void) {
  const restore: (() => void)[] = [];
  for (const el of Project.elements) {
    if (NON_RENDERED_TYPES.has(el.type) && el.mesh && el.mesh.visible !== false) {
      const mesh = el.mesh;
      mesh.visible = false;
      restore.push(() => { mesh.visible = true; });
    }
  }
  if (!includeReferenceModels && typeof PreviewModel !== 'undefined') {
    try {
      for (const model of PreviewModel.getActiveModels()) {
        const obj = model.model_3d;
        if (obj && obj.visible !== false) {
          obj.visible = false;
          restore.push(() => { obj.visible = true; });
        }
      }
    } catch { /* ignore */ }
  }
  // Selection highlight lifts colours — force it off for the render.
  let highlighted = false;
  try {
    for (const el of Project.elements) {
      if (el.selected && el.preview_controller?.updateHighlight) {
        el.preview_controller.updateHighlight(el, undefined, true);
        highlighted = true;
      }
    }
  } catch { /* ignore */ }
  try {
    Canvas.withoutGizmos(fn);
  } finally {
    restore.forEach((r) => r());
    if (highlighted) { try { Canvas.updateCubeHighlights(); } catch { /* ignore */ } }
  }
}

// ───────────────────────────── passes ─────────────────────────────

function readTarget(c: Ctx, out: Uint8Array) {
  c.renderer.readRenderTargetPixels(c.rt, 0, 0, c.w, c.h, out);
}

function renderInto(c: Ctx, scene: any, camera: any, out: Uint8Array) {
  c.renderer.setRenderTarget(c.rt);
  c.renderer.setClearColor(0x000000, 0);
  c.renderer.clear(true, true, false);
  c.renderer.render(scene, camera);
  readTarget(c, out);
  c.renderer.setRenderTarget(null);
}

/**
 * Render one frame (the scene as currently posed) for a view basis + frame
 * spec and collapse it to pixel buffers. Synchronous; ~milliseconds per frame.
 */
export function renderPixelFrame(basis: ViewBasis, frame: FrameSpec, bounds: ViewBounds, opts: RenderPassOptions): PixelBuffers {
  const S = Math.max(1, Math.min(8, Math.round(opts.supersample)));
  const W = frame.width, H = frame.height;
  const sw = W * S, sh = H * S;
  const c = getContext(sw, sh);
  const scene = Canvas.scene || (window as any).scene;
  scene.updateMatrixWorld(true);
  const camera = buildOrthoCamera(basis, frame, bounds);

  const albedo = new Uint8Array(sw * sh * 4);
  const lit = new Uint8Array(sw * sh * 4);
  const geo = new Uint8Array(sw * sh * 4);
  const ids = new Uint8Array(sw * sh * 4);
  const depthNear = bounds.dmin - 2;
  const depthFar = bounds.dmax + 2;

  withCleanScene(opts.include_reference_models, () => {
    const swapped: { mesh: any; material: any }[] = [];
    const swapWith = (mesh: any, replace: (m: any) => any) => {
      if (!mesh || !mesh.isMesh || !mesh.material) return;
      const original = mesh.material;
      swapped.push({ mesh, material: original });
      mesh.material = Array.isArray(original) ? original.map(replace) : replace(original);
    };
    const restore = () => { for (const s of swapped) s.mesh.material = s.material; swapped.length = 0; };
    const extraMeshes: any[] = [];
    for (const obj of opts.extra_objects || []) obj.traverse?.((child: any) => { if (child.isMesh && child.visible !== false) extraMeshes.push(child); });

    // Albedo: Blockbench materials with SHADE off, reference models unlit.
    try {
      for (const mesh of extraMeshes) swapWith(mesh, unlitMaterialFor);
      withShading(false, () => renderInto(c, scene, camera, albedo));
    } finally { restore(); }

    // Lit: the app's own face shading (reference models keep their scene lighting).
    withShading(true, () => renderInto(c, scene, camera, lit));

    // Geometry: packed view-space normal + depth for every mesh in the sprite.
    const elements = renderableElements();
    try {
      for (const el of elements) swapWith(el.mesh, (m) => geoMaterialFor(m, depthNear, depthFar));
      for (const mesh of extraMeshes) swapWith(mesh, (m) => geoMaterialFor(m, depthNear, depthFar));
      renderInto(c, scene, camera, geo);
    } finally { restore(); }

    // Part ids: one flat colour per bone (shared materials get the id per draw).
    const partIndex = new Map<string, number>();
    const idOf = (key: string) => { let id = partIndex.get(key); if (!id) { id = partIndex.size + 1; partIndex.set(key, id); } return id; };
    const hooked: { mesh: any; before: any }[] = [];
    const hook = (mesh: any, id: number) => {
      hooked.push({ mesh, before: mesh.onBeforeRender });
      const v = new THREE.Vector3(((id >> 16) & 255) / 255, ((id >> 8) & 255) / 255, (id & 255) / 255);
      mesh.onBeforeRender = (_r: any, _s: any, _c: any, _g: any, material: any) => {
        if (!material?.uniforms?.idColor) return;
        material.uniforms.idColor.value.copy(v);
        // Shared material drawn back-to-back: force the uniform upload for THIS draw.
        material.uniformsNeedUpdate = true;
      };
    };
    try {
      for (const el of elements) {
        const id = idOf(partKeyOf(el));
        swapWith(el.mesh, (m) => idMaterialFor(m, id));
        hook(el.mesh, id);
      }
      let extraId = 1_000_000;
      for (const mesh of extraMeshes) {
        const id = extraId++;
        swapWith(mesh, (m) => idMaterialFor(m, id));
        hook(mesh, id);
      }
      renderInto(c, scene, camera, ids);
    } finally {
      restore();
      for (const h of hooked) h.mesh.onBeforeRender = h.before;
    }
  });

  return downsample(albedo, lit, geo, ids, sw, sh, S, W, H, opts, depthNear, depthFar);
}

// ───────────────────────────── downsampling ─────────────────────────────

/** Sample offsets within an SxS block, nearest-to-centre first. */
function sampleOrder(S: number): [number, number][] {
  const list: [number, number][] = [];
  const c = (S - 1) / 2;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) list.push([x, y]);
  list.sort((a, b) => ((a[0] - c) ** 2 + (a[1] - c) ** 2) - ((b[0] - c) ** 2 + (b[1] - c) ** 2));
  return list;
}

function downsample(
  albedo: Uint8Array, lit: Uint8Array, geo: Uint8Array, ids: Uint8Array,
  sw: number, sh: number, S: number, W: number, H: number,
  opts: RenderPassOptions, depthNear: number, depthFar: number,
): PixelBuffers {
  const out: PixelBuffers = {
    width: W, height: H,
    alpha: new Uint8Array(W * H),
    albedo: new Uint8ClampedArray(W * H * 3),
    lit: new Uint8ClampedArray(W * H * 3),
    normal: new Float32Array(W * H * 3),
    depth: new Float32Array(W * H),
    coverage: new Float32Array(W * H),
    part: new Uint32Array(W * H),
  };
  const order = sampleOrder(S);
  const total = S * S;
  const threshold = Math.max(0.01, Math.min(1, opts.alpha_threshold));
  const counts = new Map<number, { n: number; k: number; i: number }>();
  const rgb = [0, 0, 0];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      counts.clear();
      let covered = 0;
      let chosen = -1;
      for (let k = 0; k < order.length; k++) {
        const sx = x * S + order[k][0];
        const sy = y * S + order[k][1];
        const row = sh - 1 - sy; // WebGL rows are bottom-up
        const i = (row * sw + sx) * 4;
        const a = albedo[i + 3];
        if (a < 128) continue;
        covered++;
        if (opts.sampling === 'center') {
          if (chosen < 0) chosen = i; // samples come nearest-to-centre first
          continue;
        }
        // Un-premultiply semi-transparent texels blended onto the clear colour.
        let r = albedo[i], g = albedo[i + 1], b = albedo[i + 2];
        if (a < 255) { r = Math.min(255, Math.round(r * 255 / a)); g = Math.min(255, Math.round(g * 255 / a)); b = Math.min(255, Math.round(b * 255 / a)); }
        const key = (r << 16) | (g << 8) | b;
        const entry = counts.get(key);
        if (entry) entry.n++;
        else counts.set(key, { n: 1, k, i });
      }
      if (opts.sampling !== 'center') {
        // Mode filter; ties go to the colour that appeared nearest the centre.
        let best: { n: number; k: number; i: number } | null = null;
        for (const entry of counts.values()) {
          if (!best || entry.n > best.n || (entry.n === best.n && entry.k < best.k)) best = entry;
        }
        if (best) chosen = best.i;
      }
      const p = y * W + x;
      out.coverage[p] = covered / total;
      if (covered / total + 1e-9 < threshold || chosen < 0) {
        out.alpha[p] = 0;
        continue;
      }
      out.alpha[p] = 255;
      const a = albedo[chosen + 3];
      rgb[0] = albedo[chosen]; rgb[1] = albedo[chosen + 1]; rgb[2] = albedo[chosen + 2];
      if (a < 255 && a > 0) { for (let j = 0; j < 3; j++) rgb[j] = Math.min(255, Math.round(rgb[j] * 255 / a)); }
      out.albedo[p * 3] = rgb[0]; out.albedo[p * 3 + 1] = rgb[1]; out.albedo[p * 3 + 2] = rgb[2];
      const la = lit[chosen + 3];
      let lr = lit[chosen], lg = lit[chosen + 1], lb = lit[chosen + 2];
      if (la < 255 && la > 0) { lr = Math.min(255, Math.round(lr * 255 / la)); lg = Math.min(255, Math.round(lg * 255 / la)); lb = Math.min(255, Math.round(lb * 255 / la)); }
      out.lit[p * 3] = lr; out.lit[p * 3 + 1] = lg; out.lit[p * 3 + 2] = lb;
      const nx = geo[chosen] / 255 * 2 - 1;
      const ny = geo[chosen + 1] / 255 * 2 - 1;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      out.normal[p * 3] = nx; out.normal[p * 3 + 1] = ny; out.normal[p * 3 + 2] = nz;
      const d01 = (geo[chosen + 2] + geo[chosen + 3] / 255) / 255;
      out.depth[p] = depthNear + d01 * (depthFar - depthNear);
      out.part[p] = ids[chosen + 3] ? ((ids[chosen] << 16) | (ids[chosen + 1] << 8) | ids[chosen + 2]) : 0;
    }
  }
  return out;
}
