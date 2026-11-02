// Bridge to the BlockSmooth plugin (window.BlockSmooth): non-destructive
// subdivision, creases and smooth-by-angle shading for meshes. BlockSmooth is a
// separate Blockbench plugin; this module is the only place that knows its API,
// so the handlers and renderers stay independent of it.

import { fail } from './registry';

/** The BlockSmooth API version this bridge speaks. */
const API_VERSION = 1;

/** window.BlockSmooth, or a failure that says how to get it. */
export function blockSmooth(): any {
  const api = (window as any).BlockSmooth;
  if (!api) {
    fail('The BlockSmooth plugin is not loaded in Blockbench. Install blocksmooth.js (File > Plugins > Load Plugin from File, or the plugin store) — it provides subdivision surfaces, edge creases and smooth-by-angle shading — then retry.');
  }
  if (api.api_version !== API_VERSION) {
    fail(`BlockSmooth API version ${api.api_version} is not supported by this Blockbench MCP (expects ${API_VERSION}). Update both to their latest releases.`);
  }
  return api;
}

/** Run a BlockSmooth API call; its errors (plain Error with a recovery hint) become tool failures. */
export function callBlockSmooth<T>(fn: (api: any) => T): T {
  const api = blockSmooth();
  try {
    return fn(api);
  } catch (err) {
    fail(`BlockSmooth: ${(err as Error).message}`);
  }
}

/**
 * The three.js object that draws an element on screen: BlockSmooth's smooth
 * result when it shows one (the element's own mesh is then an invisible
 * picking cage), otherwise the element's own mesh. Renderers that swap
 * materials must swap them on this object.
 */
export function drawnObject(el: any): any {
  const api = (window as any).BlockSmooth;
  if (api && typeof api.getDisplayObject === 'function' && el instanceof Mesh) {
    try {
      return api.getDisplayObject(el) ?? el.mesh;
    } catch {
      return el.mesh;
    }
  }
  return el.mesh;
}
