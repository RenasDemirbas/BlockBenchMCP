// Pixel-art camera: named views (side, 3/4 top-down, 2:1 isometric …),
// direction sets, and a pixel-aligned orthographic frame where 1 px is an
// exact fraction of a model unit and the model origin lands on a pixel corner.
//
// Conventions (Blockbench): +X east, −Z north, entities face north. Yaw is the
// camera's azimuth: 0 = camera on the north side looking at the model's front,
// 90 = camera east (the front points to the image's RIGHT — the classic
// platformer "side" view), 180 = behind, 270 = camera west. Pitch is the
// elevation above the horizon: 0 = straight on, 30 = pixel isometric / 2:1,
// 90 = straight down.
import { fail } from '../registry';

export type V3 = [number, number, number];

export interface ViewPreset {
  yaw: number;
  pitch: number;
  description: string;
}

export const VIEW_PRESETS: Record<string, ViewPreset> = {
  side: { yaw: 90, pitch: 0, description: 'Platformer side view — the model faces RIGHT' },
  right: { yaw: 90, pitch: 0, description: 'Same as side' },
  left: { yaw: 270, pitch: 0, description: 'Side view, the model faces LEFT' },
  front: { yaw: 0, pitch: 0, description: 'Straight-on front (north face)' },
  back: { yaw: 180, pitch: 0, description: 'Straight-on back' },
  top: { yaw: 180, pitch: 90, description: 'Straight down, north at the top of the image' },
  bottom: { yaw: 0, pitch: -90, description: 'Straight up from below' },
  three_quarter: { yaw: 0, pitch: 30, description: 'RPG "3/4 top-down": front view tilted 30° (walls tall, floor squashed 2:1)' },
  rpg: { yaw: 0, pitch: 30, description: 'Alias of three_quarter' },
  top_down: { yaw: 0, pitch: 60, description: 'Steeper top-down (60°) — more roof, less face' },
  isometric: { yaw: 315, pitch: 30, description: 'Pixel isometric (2:1 dimetric): 30° elevation, camera north-west' },
  isometric_right: { yaw: 315, pitch: 30, description: 'Pixel isometric from the north-west (Blockbench naming)' },
  isometric_left: { yaw: 45, pitch: 30, description: 'Pixel isometric from the north-east' },
  true_isometric: { yaw: 315, pitch: 35.264, description: 'True isometric (35.264°) — not pixel-grid friendly' },
  true_isometric_left: { yaw: 45, pitch: 35.264, description: 'True isometric from the north-east' },
  side_three_quarter: { yaw: 90, pitch: 30, description: 'Side view tilted 30° (Zelda-like side sprites)' },
};

export function viewPresetNames(): string[] {
  return Object.keys(VIEW_PRESETS);
}

export function resolveView(view: string | undefined, yaw?: number, pitch?: number): { yaw: number; pitch: number; name: string } {
  let base = { yaw: 90, pitch: 0 };
  let name = 'side';
  if (view) {
    const preset = VIEW_PRESETS[String(view).toLowerCase()];
    if (!preset) fail(`Unknown view "${view}". Valid views: ${viewPresetNames().join(', ')} — or pass "yaw" and "pitch" (degrees).`);
    base = { yaw: preset.yaw, pitch: preset.pitch };
    name = String(view).toLowerCase();
  }
  const y = typeof yaw === 'number' ? yaw : base.yaw;
  const p = typeof pitch === 'number' ? pitch : base.pitch;
  if (!isFinite(y) || !isFinite(p) || p < -90 || p > 90) fail(`Invalid camera angles yaw=${yaw} pitch=${pitch}. Pitch must be within -90..90.`);
  // File-name friendly label for custom angles, e.g. "yaw45_pitch0".
  if (typeof yaw === 'number' || typeof pitch === 'number') name = `yaw${Math.round(((y % 360) + 360) % 360)}_pitch${Math.round(p)}`;
  return { yaw: ((y % 360) + 360) % 360, pitch: p, name };
}

// ───────────────────────────── directions ─────────────────────────────

const SCREEN_NAMES_8 = ['down', 'down_right', 'right', 'up_right', 'up', 'up_left', 'left', 'down_left'];
const COMPASS_NAMES_16 = ['S', 'SSE', 'SE', 'ESE', 'E', 'ENE', 'NE', 'NNE', 'N', 'NNW', 'NW', 'WNW', 'W', 'WSW', 'SW', 'SSW'];

export interface DirectionSpec {
  index: number;
  yaw: number;
  pitch: number;
  /** The direction the model FACES on screen (down = toward the viewer). */
  name: string;
  /** Same, as a compass point for top-down maps where up = north. */
  compass: string;
  /** Rendered from the mirrored direction and flipped (mirror_directions). */
  mirrored_from?: number;
}

/** Name of the facing direction for a camera yaw (screen + compass). */
export function directionNames(yaw: number): { name: string; compass: string } {
  const y = ((yaw % 360) + 360) % 360;
  const i16 = Math.round(y / 22.5) % 16;
  const compass = COMPASS_NAMES_16[i16];
  const i8 = Math.round(y / 45) % 8;
  const exact8 = Math.abs(y - i8 * 45) < 0.01;
  const name = exact8 ? SCREEN_NAMES_8[i8] : `yaw_${Math.round(y)}`;
  return { name, compass };
}

export function buildDirections(count: number, baseYaw: number, pitch: number, mirror: boolean): DirectionSpec[] {
  const n = Math.max(1, Math.round(count));
  if (![1, 2, 4, 8, 16].includes(n) && n > 16) fail(`"directions" must be between 1 and 16 (typically 4 or 8), got ${count}.`);
  const dirs: DirectionSpec[] = [];
  for (let i = 0; i < n; i++) {
    const yaw = ((baseYaw + (i * 360) / n) % 360 + 360) % 360;
    const names = directionNames(yaw);
    dirs.push({ index: i, yaw, pitch, name: names.name, compass: names.compass });
  }
  if (mirror && n >= 4) {
    // Render the "right-facing" half, mirror the rest. Left/right symmetry is
    // about the model's own X axis, i.e. camera yaw θ ↔ 360−θ … but the frame
    // must be flipped relative to the base yaw, so mirror about baseYaw.
    for (const d of dirs) {
      const rel = ((d.yaw - baseYaw) % 360 + 360) % 360;
      if (rel > 180.001) {
        const partnerYaw = ((baseYaw - rel) % 360 + 360) % 360;
        const partner = dirs.find((o) => Math.abs(((o.yaw - partnerYaw) % 360 + 360) % 360) < 0.01);
        if (partner) d.mirrored_from = partner.index;
      }
    }
  }
  return dirs;
}

// ───────────────────────────── view basis ─────────────────────────────

export interface ViewBasis {
  /** Unit vector from the target toward the camera. */
  dir: V3;
  forward: V3;
  right: V3;
  up: V3;
}

const deg = (d: number) => (d * Math.PI) / 180;
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function viewBasis(yaw: number, pitch: number): ViewBasis {
  const cy = Math.cos(deg(yaw)), sy = Math.sin(deg(yaw));
  const cp = Math.cos(deg(pitch)), sp = Math.sin(deg(pitch));
  const dir: V3 = norm([sy * cp, sp, -cy * cp]);
  const forward: V3 = [-dir[0], -dir[1], -dir[2]];
  // Straight up/down: keep the image continuous with the tilted views (the
  // "away from the camera" direction becomes image-up: north for "top").
  const upHint: V3 = Math.abs(sp) > 0.9999 ? [-sy, 0, cy] : [0, 1, 0];
  const right = norm(cross(forward, upHint));
  const up = norm(cross(right, forward));
  return { dir, forward, right, up };
}

// ───────────────────────────── bounds ─────────────────────────────

const NON_RENDERED_TYPES = new Set(['locator', 'null_object', 'bounding_box', 'armature', 'armature_bone']);

/** Elements that contribute pixels: visible cubes/meshes/planes etc. */
export function renderableElements(): any[] {
  const out: any[] = [];
  for (const el of Project.elements) {
    if (el.visibility === false) continue;
    if (NON_RENDERED_TYPES.has(el.type)) continue;
    if (!el.mesh || !el.mesh.geometry) continue;
    out.push(el);
  }
  return out;
}

export interface ViewBounds {
  umin: number; umax: number; vmin: number; vmax: number;
  /** Depth range along "forward" (smaller = closer to the camera). */
  dmin: number; dmax: number;
  /** The model origin in view coordinates. */
  origin: { u: number; v: number; d: number };
  any: boolean;
}

/** Project every visible element's oriented bounding box into the view basis. */
export function projectBounds(basis: ViewBasis, elements: any[], extraObjects: any[] = []): ViewBounds {
  const scene = Canvas.scene || (window as any).scene;
  scene.updateMatrixWorld(true);
  const b: ViewBounds = { umin: Infinity, umax: -Infinity, vmin: Infinity, vmax: -Infinity, dmin: Infinity, dmax: -Infinity, origin: { u: 0, v: 0, d: 0 }, any: false };
  const corner = new THREE.Vector3();
  const addPoint = (p: any) => {
    const v: V3 = [p.x, p.y, p.z];
    const u = dot(v, basis.right), w = dot(v, basis.up), d = dot(v, basis.forward);
    if (u < b.umin) b.umin = u; if (u > b.umax) b.umax = u;
    if (w < b.vmin) b.vmin = w; if (w > b.vmax) b.vmax = w;
    if (d < b.dmin) b.dmin = d; if (d > b.dmax) b.dmax = d;
    b.any = true;
  };
  const addObject = (obj: any) => {
    obj.traverse?.((child: any) => {
      if (!child.isMesh || !child.geometry || child.visible === false) return;
      const geo = child.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb || bb.isEmpty()) return;
      for (let i = 0; i < 8; i++) {
        corner.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
        corner.applyMatrix4(child.matrixWorld);
        addPoint(corner);
      }
    });
  };
  for (const el of elements) addObject(el.mesh);
  for (const obj of extraObjects) addObject(obj);
  if (!b.any) {
    b.umin = -8; b.umax = 8; b.vmin = 0; b.vmax = 16; b.dmin = -8; b.dmax = 8;
  }
  return b;
}

// ───────────────────────────── pixel frame ─────────────────────────────

export interface FrameSpec {
  width: number;
  height: number;
  pixels_per_unit: number;
  /** View-space coordinates of the frame centre. */
  cu: number;
  cv: number;
  /** Model origin in pixel coordinates (from the top-left, pixel-corner space). */
  pivot: [number, number];
  /** How the frame was anchored. */
  anchor: 'origin' | 'bounds' | 'center';
  /** True when the model does not fit at the requested scale. */
  clipped: boolean;
  /** Frame size that would fit everything at this scale. */
  required_size: [number, number];
}

export interface FitOptions {
  width: number;
  height: number;
  padding: number;
  pixels_per_unit?: number;
  scale_snap: 'texel' | 'integer' | 'half' | 'none';
  texel_density: number;
  anchor: 'auto' | 'origin' | 'bounds' | 'center';
}

/** Round a raw pixels-per-unit down onto a "clean" scale. */
export function snapScale(raw: number, mode: FitOptions['scale_snap'], density: number): number {
  if (!isFinite(raw) || raw <= 0) return 1;
  if (mode === 'none') return raw;
  let step = mode === 'integer' ? 1 : mode === 'half' ? 0.5 : 1 / Math.max(1, density);
  if (raw >= step) return Math.floor(raw / step + 1e-9) * step;
  // Model too big for an integer texel scale: fall back to power-of-two fractions.
  while (step > raw && step > 1 / 64) step /= 2;
  return step;
}

/**
 * Choose the scale and placement for a union of view-space bounds (already
 * merged across every pose/direction), keeping the model origin on a pixel
 * corner so faces at integer units stay texel-aligned.
 */
export function fitFrame(bounds: ViewBounds, opts: FitOptions): FrameSpec {
  const { width, height, padding } = opts;
  const availW = Math.max(1, width - 2 * padding);
  const availH = Math.max(1, height - 2 * padding);
  const o = bounds.origin;
  const originInside = o.u >= bounds.umin - 1e-6 && o.u <= bounds.umax + 1e-6;
  const anchor: FrameSpec['anchor'] = opts.anchor === 'auto' ? (originInside ? 'origin' : 'bounds') : opts.anchor;

  // Horizontal extent that must fit, depending on anchoring.
  const extLeft = o.u - bounds.umin, extRight = bounds.umax - o.u;
  const extW = anchor === 'origin' ? 2 * Math.max(extLeft, extRight) : bounds.umax - bounds.umin;
  const extH = bounds.vmax - bounds.vmin;

  let ppu = opts.pixels_per_unit;
  if (!ppu) {
    const raw = Math.min(availW / Math.max(extW, 1e-6), availH / Math.max(extH, 1e-6));
    ppu = snapScale(raw, opts.scale_snap, opts.texel_density);
  }
  const needW = Math.ceil(extW * ppu) + 2 * padding;
  const needH = Math.ceil(extH * ppu) + 2 * padding;
  const clipped = needW > width + 1e-6 || needH > height + 1e-6;

  // Vertical: rest the lowest point on the bottom padding line
  // (pixel y = H/2 − (v − cv)·ppu ; want y(vmin) = height − padding), or
  // centre the bounds for "center".
  let cv = anchor === 'center'
    ? (bounds.vmin + bounds.vmax) / 2
    : bounds.vmin + ((height - padding) - height / 2) / ppu;
  // Horizontal.
  let cu: number;
  if (anchor === 'origin') {
    cu = o.u; // origin at the horizontal centre
  } else {
    cu = (bounds.umin + bounds.umax) / 2;
  }
  // Snap so the origin projects onto a pixel corner.
  let px = (o.u - cu) * ppu + width / 2;
  let py = height / 2 - (o.v - cv) * ppu;
  const sx = Math.round(px) - px, sy = Math.round(py) - py;
  cu -= sx / ppu;
  cv += sy / ppu;
  px = Math.round(px); py = Math.round(py);
  return {
    width, height, pixels_per_unit: ppu, cu, cv,
    pivot: [px, py], anchor, clipped,
    required_size: [needW, needH],
  };
}

/** Build the THREE orthographic camera for a frame in a given basis. */
export function buildOrthoCamera(basis: ViewBasis, frame: FrameSpec, bounds: ViewBounds): any {
  const ppu = frame.pixels_per_unit;
  const halfW = frame.width / (2 * ppu), halfH = frame.height / (2 * ppu);
  const depthSpan = Math.max(bounds.dmax - bounds.dmin, 1);
  const dist = depthSpan + 64;
  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.5, dist + depthSpan + 128);
  const target = new THREE.Vector3(
    basis.right[0] * frame.cu + basis.up[0] * frame.cv + basis.forward[0] * bounds.dmin,
    basis.right[1] * frame.cu + basis.up[1] * frame.cv + basis.forward[1] * bounds.dmin,
    basis.right[2] * frame.cu + basis.up[2] * frame.cv + basis.forward[2] * bounds.dmin,
  );
  cam.position.set(target.x + basis.dir[0] * dist, target.y + basis.dir[1] * dist, target.z + basis.dir[2] * dist);
  cam.up.set(basis.up[0], basis.up[1], basis.up[2]);
  cam.lookAt(target);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

/** Texels per model unit, from the textures actually in use (default 1). */
export function textureTexelDensity(): number {
  const values: number[] = [];
  for (const tex of Texture.all) {
    try {
      const uvW = tex.getUVWidth?.() || Project.texture_width || tex.width;
      if (tex.width > 0 && uvW > 0) values.push(tex.width / uvW);
    } catch { /* ignore */ }
  }
  if (!values.length) return 1;
  values.sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  return Math.max(1, Math.round(median * 1000) / 1000);
}
