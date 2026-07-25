// Viewport screenshots — the model's eyes. v1.1: renders with a dedicated
// offscreen THREE.WebGLRenderer (preserveDrawingBuffer) so screenshots work
// even when the Blockbench window is minimized or covered. Falls back to
// Screencam if the offscreen path fails.
import { register, fail, requireProject } from '../registry';
import { clampInt, textureCoverage } from '../util';

const ANGLE_PRESETS = ['initial', 'top', 'bottom', 'south', 'north', 'east', 'west', 'isometric_right', 'isometric_left', 'true_isometric_right', 'true_isometric_left'];

// Fallback camera directions (from model center toward the camera) when a
// Blockbench DefaultCameraPresets entry is unavailable. Signs verified against
// Blockbench 5.1.5 presets: isometric_right looks from the NORTH-WEST (the
// front-left of a north-facing entity). Isometric views are orthographic.
const ISO_Y = 0.832; // 426.048/512 — Blockbench isometric elevation
const ANGLE_DIRECTIONS: Record<string, { dir: [number, number, number]; ortho?: boolean }> = {
  initial: { dir: [-1, 0.5, -1] },
  top: { dir: [0, 1, 0], ortho: true },
  bottom: { dir: [0, -1, 0], ortho: true },
  north: { dir: [0, 0, -1], ortho: true },
  south: { dir: [0, 0, 1], ortho: true },
  east: { dir: [1, 0, 0], ortho: true },
  west: { dir: [-1, 0, 0], ortho: true },
  isometric_right: { dir: [-1, ISO_Y, -1], ortho: true },
  isometric_left: { dir: [1, ISO_Y, -1], ortho: true },
  true_isometric_right: { dir: [-1, 1.016, -1], ortho: true },
  true_isometric_left: { dir: [1, 1.016, -1], ortho: true },
};

export interface ScreenshotOptions {
  angle?: string;
  camera?: { position: [number, number, number]; target?: [number, number, number]; projection?: string; fov?: number; zoom?: number };
  resolution?: number | [number, number];
  shading?: boolean;
  background?: string;
}

export interface ScreenshotResult {
  image: string;
  /** Fraction of pixels that are not fully transparent (offscreen path only). */
  coverage?: number;
}

// ─────────────────────────── offscreen renderer ───────────────────────────

let offscreen: { renderer: any; canvas: any } | null = null;

function getScene(): any {
  return Canvas.scene || (window as any).scene;
}

function getOffscreenRenderer(width: number, height: number): any {
  if (offscreen && offscreen.renderer.getContext()?.isContextLost?.()) {
    try { offscreen.renderer.dispose(); } catch {}
    offscreen = null;
  }
  if (!offscreen) {
    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(1);
    offscreen = { renderer, canvas };
  }
  offscreen.renderer.setSize(width, height, false);
  return offscreen.renderer;
}

/** World bounds of all visible cubes/meshes (posed if in animate mode). */
export function modelBounds(): { center: any; radius: number; box: any } {
  getScene().updateMatrixWorld(true);
  const box = new THREE.Box3();
  let any = false;
  for (const el of Project.elements) {
    if (el.visibility === false || !el.mesh || !el.mesh.geometry) continue;
    if (!(el instanceof Cube) && !(el instanceof Mesh)) continue;
    box.expandByObject(el.mesh);
    any = true;
  }
  if (!any) {
    box.set(new THREE.Vector3(-8, 0, -8), new THREE.Vector3(8, 16, 8));
  }
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  return { center: sphere.center, radius: Math.max(sphere.radius, 1), box };
}

function presetDirection(angle: string): { dir: any; ortho: boolean } {
  // Prefer Blockbench's own camera presets so views match the app exactly.
  try {
    const presets: any[] = typeof DefaultCameraPresets !== 'undefined' ? DefaultCameraPresets : [];
    const preset = presets.find((p: any) => p.id === angle);
    if (preset && Array.isArray(preset.position)) {
      const pos = new THREE.Vector3().fromArray(preset.position);
      const tgt = new THREE.Vector3().fromArray(preset.target || [0, 0, 0]);
      const dir = pos.sub(tgt);
      if (dir.lengthSq() > 1e-6) {
        return { dir: dir.normalize(), ortho: preset.projection === 'orthographic' };
      }
    }
  } catch {}
  const fallback = ANGLE_DIRECTIONS[angle];
  if (!fallback) {
    fail(`Unknown angle preset "${angle}". Valid: view (current viewport), ${ANGLE_PRESETS.join(', ')}. Or pass an explicit "camera" {position, target}.`);
  }
  return { dir: new THREE.Vector3().fromArray(fallback.dir).normalize(), ortho: !!fallback.ortho };
}

function buildCamera(options: ScreenshotOptions, aspect: number): any {
  const FOV = 45;
  if (options.camera) {
    const c = options.camera;
    const target = new THREE.Vector3().fromArray(c.target ?? [0, 8, 0]);
    const pos = new THREE.Vector3().fromArray(c.position);
    if (c.projection === 'orthographic') {
      const dist = Math.max(pos.distanceTo(target), 1);
      const halfH = dist * Math.tan(((c.fov ?? FOV) / 2) * Math.PI / 180);
      const cam = new THREE.OrthographicCamera(-halfH * aspect, halfH * aspect, halfH, -halfH, 0.1, dist * 20 + 512);
      cam.position.copy(pos);
      cam.lookAt(target);
      cam.updateProjectionMatrix();
      return cam;
    }
    const cam = new THREE.PerspectiveCamera(c.fov ?? FOV, aspect, 0.1, 30000);
    cam.position.copy(pos);
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    return cam;
  }

  const angle = options.angle ?? 'isometric_right';
  if (angle === 'view') {
    const src = Preview.selected?.camera;
    if (!src) fail('No viewport is available for angle "view". Use an angle preset or an explicit camera.');
    const cam = src.clone();
    if (cam.isPerspectiveCamera) {
      cam.aspect = aspect;
    } else {
      const halfH = (cam.top - cam.bottom) / 2;
      cam.left = -halfH * aspect;
      cam.right = halfH * aspect;
    }
    cam.updateProjectionMatrix();
    return cam;
  }

  const { dir, ortho } = presetDirection(angle);
  const { center, radius } = modelBounds();
  const up = Math.abs(dir.y) > 0.99
    ? new THREE.Vector3(0, 0, dir.y > 0 ? -1 : 1) // top/bottom: north points up in the image
    : new THREE.Vector3(0, 1, 0);
  const margin = 1.15;
  if (ortho) {
    const halfH = radius * margin;
    const cam = new THREE.OrthographicCamera(-halfH * aspect, halfH * aspect, halfH, -halfH, 0.1, radius * 24 + 512);
    cam.position.copy(center.clone().add(dir.clone().multiplyScalar(radius * 4 + 24)));
    cam.up.copy(up);
    cam.lookAt(center);
    cam.updateProjectionMatrix();
    return cam;
  }
  const dist = (radius * margin) / Math.sin((FOV / 2) * Math.PI / 180);
  const cam = new THREE.PerspectiveCamera(FOV, aspect, 0.1, dist + radius * 12 + 512);
  cam.position.copy(center.clone().add(dir.clone().multiplyScalar(dist)));
  cam.up.copy(up);
  cam.lookAt(center);
  cam.updateProjectionMatrix();
  return cam;
}

/** Fraction of non-transparent pixels in the last render (cheap subsample). */
function renderCoverage(renderer: any, width: number, height: number): number | undefined {
  try {
    const gl = renderer.getContext();
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let visible = 0, sampled = 0;
    const step = Math.max(1, Math.floor((width * height) / 40000));
    for (let i = 0; i < width * height; i += step) {
      sampled++;
      if (pixels[i * 4 + 3] > 8) visible++;
    }
    return sampled ? visible / sampled : undefined;
  } catch {
    return undefined;
  }
}

/** Render the scene offscreen — independent of window visibility/minimization. */
function renderOffscreen(options: ScreenshotOptions, width: number, height: number): ScreenshotResult {
  const camera = buildCamera(options, width / height);
  const renderer = getOffscreenRenderer(width, height);
  if (options.background) {
    renderer.setClearColor(new THREE.Color(options.background), 1);
  } else {
    renderer.setClearAlpha(0);
  }
  const scene = getScene();
  scene.updateMatrixWorld(true);
  let dataUrl = '';
  let coverage: number | undefined;
  Canvas.withoutGizmos(() => {
    renderer.render(scene, camera);
    coverage = renderCoverage(renderer, width, height);
    dataUrl = offscreen!.canvas.toDataURL('image/png');
  });
  if (!dataUrl || dataUrl.length < 256) throw new Error('Offscreen render produced an empty image');
  return { image: dataUrl, coverage };
}

// ───────────────────────── legacy (viewport) path ─────────────────────────

function takeScreenshotLegacy(options: ScreenshotOptions, width: number, height: number): Promise<string> {
  if (options.camera) {
    const preview = Screencam.NoAAPreview;
    preview.resize(width, height);
    preview.setProjectionMode(options.camera.projection === 'orthographic');
    preview.camera.position.set(...options.camera.position);
    const target = options.camera.target ?? [0, 8, 0];
    preview.controls.target.set(...target);
    if (options.camera.fov) preview.setFOV(options.camera.fov);
    return new Promise((resolve) => {
      Canvas.withoutGizmos(() => {
        preview.render();
        resolve(preview.canvas.toDataURL('image/png'));
      });
    });
  }
  const angle = options.angle ?? 'isometric_right';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Screenshot timed out after 20s')), 20000);
    try {
      Screencam.advancedScreenshot(Preview.selected, {
        angle_preset: angle,
        resolution: [width, height],
        anti_aliasing: 'ssaa',
        shading: options.shading !== false,
        show_gizmos: false,
      }, (dataUrl: string) => {
        clearTimeout(timer);
        resolve(dataUrl);
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

export async function takeScreenshot(options: ScreenshotOptions = {}): Promise<string> {
  return (await takeScreenshotDetailed(options)).image;
}

export async function takeScreenshotDetailed(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  requireProject();
  const res = options.resolution;
  const [width, height] = Array.isArray(res)
    ? [clampInt(res[0], 64, 1600), clampInt(res[1], 64, 1600)]
    : [clampInt((res as number) ?? 960, 64, 1600), clampInt((res as number) ?? 960, 64, 1600)];

  const angle = options.angle ?? (options.camera ? undefined : 'isometric_right');
  if (angle && angle !== 'view' && !ANGLE_PRESETS.includes(angle)) {
    fail(`Unknown angle preset "${angle}". Valid: view (current viewport), ${ANGLE_PRESETS.join(', ')}. Or pass an explicit "camera" {position, target}.`);
  }

  // Honor the shading option like Screencam does: flip the global shading
  // setting for the duration of the render (set() re-fires Canvas.updateShading).
  const prevShading = settings.shading?.value;
  const flipShading = typeof options.shading === 'boolean' && settings.shading && options.shading !== prevShading;
  if (flipShading) settings.shading.set(options.shading);
  try {
    try {
      return renderOffscreen(options, width, height);
    } catch (err: any) {
      console.warn('[MCP] offscreen render failed, falling back to Screencam:', err?.message || err);
      return { image: await takeScreenshotLegacy(options, width, height) };
    }
  } finally {
    if (flipShading) settings.shading.set(prevShading);
  }
}

/**
 * Explain a blank-looking render instead of returning a silently white image.
 * Two causes dominate, and neither is a renderer fault:
 *  - a fully transparent texture (faces draw nothing),
 *  - faces with no texture at all (they render plain white).
 * Both are reported regardless of coverage, because a white model on a
 * transparent background reads as "empty PNG" to the caller.
 */
function emptyRenderDiagnosis(coverage: number | undefined): string | undefined {
  const notes: string[] = [];
  const blankTextures = Texture.all.filter((t: any) => textureCoverage(t).fully_transparent).map((t: any) => t.name);
  if (blankTextures.length) {
    notes.push(`${blankTextures.length === Texture.all.length && Texture.all.length === 1 ? 'The model texture is' : 'These textures are'} FULLY TRANSPARENT: ${blankTextures.join(', ')}. Faces using them draw nothing — the model looks invisible in Blockbench and blank in screenshots. Paint it (paint_faces / paint_texture / generate_texture_template) or recreate it with a fill_color.`);
  }
  if (Texture.all.length) {
    let untextured = 0;
    for (const cube of Cube.all) {
      for (const fkey in cube.faces) {
        const face = cube.faces[fkey];
        if (face.enabled === false || face.texture === null) continue;
        if (!face.getTexture?.()) { untextured++; break; }
      }
    }
    if (untextured) {
      notes.push(`${untextured} cube(s) have faces with no texture assigned — those render plain WHITE, which is invisible against a white background. Use apply_texture, or pass "background" to capture_screenshot to see them.`);
    }
  }
  if (coverage !== undefined && coverage <= 0.002) {
    const visibleElements = Project.elements.filter((e: any) => e.visibility !== false && (e instanceof Cube || e instanceof Mesh)).length;
    if (!visibleElements) notes.push('The project has no visible cubes or meshes.');
    else if (!notes.length) notes.push('The render is empty although the model has visible geometry — the camera may be framed off the model. Try angle "isometric_right" or an explicit camera.');
  }
  return notes.length ? notes.join(' ') : undefined;
}

register('capture_screenshot', async (params) => {
  const shot = await takeScreenshotDetailed(params || {});
  const warning = emptyRenderDiagnosis(shot.coverage);
  return {
    angle: params?.camera ? 'custom' : (params?.angle ?? 'isometric_right'),
    coverage: shot.coverage !== undefined ? Math.round(shot.coverage * 1000) / 1000 : undefined,
    warning,
    __image: shot.image,
  };
});

register('capture_multi_view', async (params) => {
  const views: string[] = Array.isArray(params?.views) && params.views.length
    ? params.views.slice(0, 6)
    : ['north', 'east', 'top', 'isometric_right'];
  const resolution = clampInt(params?.resolution ?? 480, 128, 800);
  const images: string[] = [];
  let minCoverage: number | undefined;
  for (const angle of views) {
    const shot = await takeScreenshotDetailed({ angle, resolution, background: params?.background });
    images.push(shot.image);
    if (shot.coverage !== undefined) minCoverage = minCoverage === undefined ? shot.coverage : Math.min(minCoverage, shot.coverage);
  }
  return {
    views,
    note: 'Images are in the same order as "views".',
    warning: emptyRenderDiagnosis(minCoverage),
    __images: images,
  };
});
