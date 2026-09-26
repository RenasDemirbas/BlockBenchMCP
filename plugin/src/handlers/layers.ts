// Texture layers and (5.2+) layer groups: inspect, create, reorder, blend,
// merge — and the bitmap-target helper the paint tools use to draw into one
// named layer instead of whatever layer happens to be active.
import { register, fail, requireProject } from '../registry';
import { resolveTexture } from '../util';

const BLEND_MODES = ['default', 'set_opacity', 'color', 'multiply', 'add', 'darken', 'lighten', 'screen', 'overlay', 'difference', 'alpha_mask'];

const hasLayerGroups = () => typeof TextureLayerGroup !== 'undefined';
const isGroup = (item: any) => item?.type === 'layer_group';

/** Keep a texture's layer list in the order the hierarchy needs (5.2+). */
function solveOrder(tex: any) {
  if (typeof TextureLayerItem !== 'undefined' && TextureLayerItem.solveLayerOrder) {
    tex.layers.replace(TextureLayerItem.solveLayerOrder(tex.layers));
  }
}

/** Layer or layer group by uuid or name (case-insensitive). */
export function findLayer(tex: any, id: string): any {
  if (!tex.layers_enabled) return null;
  const lower = String(id).toLowerCase();
  return tex.layers.find((l: any) => l.uuid === id)
    || tex.layers.find((l: any) => String(l.name).toLowerCase() === lower)
    || null;
}

function requireLayer(tex: any, id: string, label: string): any {
  if (!id) fail(`${label}: pass the layer name or uuid.`);
  const layer = findLayer(tex, id);
  if (!layer) {
    fail(`${label}: texture "${tex.name}" has no layer "${id}". Layers: ${tex.layers_enabled ? tex.layers.map((l: any) => l.name).join(', ') || 'none' : 'layers are not enabled on this texture'}.`);
  }
  return layer;
}

function requireGroup(tex: any, id: string, label: string): any {
  const group = requireLayer(tex, id, label);
  if (!isGroup(group)) fail(`${label}: "${group.name}" is a pixel layer, not a layer group.`);
  return group;
}

/** Turn layers on, converting the current bitmap into the base layer. */
function enableLayers(tex: any) {
  if (tex.layers_enabled) return false;
  if (!tex.internal) tex.convertToInternal();
  tex.activateLayers(false);
  return true;
}

/** Opacity input is 0-1 like every other MCP paint parameter; Blockbench stores 0-100. */
function toLayerOpacity(value: number): number {
  const pct = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, pct));
}

function describeLayer(tex: any, layer: any): any {
  const out: any = {
    uuid: layer.uuid,
    name: layer.name,
    type: isGroup(layer) ? 'group' : 'layer',
    parent: layer.parent_uuid ? (tex.layers.find((l: any) => l.uuid === layer.parent_uuid)?.name ?? null) : null,
    visible: layer.visible !== false,
  };
  if (!isGroup(layer)) {
    out.opacity = Math.round(layer.opacity) / 100;
    out.blend_mode = layer.blend_mode;
    out.offset = layer.offset?.slice();
    out.size = [layer.width, layer.height];
  }
  if (tex.selected_layer === layer) out.active = true;
  return out;
}

/** Layer list, BOTTOM first (the order Blockbench composites them in). */
export function layerTree(tex: any): any {
  return {
    texture: tex.name,
    layers_enabled: !!tex.layers_enabled,
    order: 'bottom → top (later layers draw over earlier ones)',
    layers: tex.layers_enabled ? tex.layers.map((l: any) => describeLayer(tex, l)) : [],
  };
}

/** New full-texture-size pixel layer, placed on top (inside `parent` if given). */
function createPixelLayer(tex: any, def: any): any {
  const layer = new TextureLayer({
    name: def.name || `layer #${tex.layers.length + 1}`,
    offset: [0, 0],
  }, tex);
  layer.setSize(tex.width, tex.height);
  if (def.opacity != null) layer.opacity = toLayerOpacity(def.opacity);
  if (def.blend_mode != null) layer.blend_mode = def.blend_mode;
  if (def.visible === false) layer.visible = false;
  if (def.fill_color) {
    layer.ctx.fillStyle = def.fill_color;
    layer.ctx.fillRect(0, 0, layer.width, layer.height);
  }
  if (def.parent && def.parent !== 'root') layer.parent_uuid = requireGroup(tex, def.parent, 'add_layer').uuid;
  insertLayer(tex, layer, def);
  return layer;
}

/** Insert (or move) an item above/below a sibling, else on top. */
function insertLayer(tex: any, item: any, def: any) {
  const list = tex.layers;
  if (list.includes(item)) list.remove(item);
  const anchorId = def.above ?? def.below;
  if (anchorId) {
    const anchor = requireLayer(tex, anchorId, 'layer position');
    if (anchor === item) fail(`A layer cannot be placed relative to itself ("${item.name}").`);
    const idx = list.indexOf(anchor);
    list.splice(def.above ? idx + 1 : idx, 0, item);
    if (def.parent === undefined) item.parent_uuid = anchor.parent_uuid || '';
  } else if (def.index != null) {
    list.splice(Math.max(0, Math.min(list.length, Math.round(def.index))), 0, item);
  } else {
    list.push(item);
  }
  solveOrder(tex);
}

/**
 * Where a paint op should draw. Without a layer name this is Blockbench's own
 * active layer (or the plain bitmap); with one it is that layer — created on
 * top, full texture size, if it does not exist yet. Either way the offset of
 * the target canvas comes back, because layers can be smaller than the
 * texture and texture-space coordinates must be shifted onto them.
 */
export function paintTarget(tex: any, layerName?: string): { canvas: any; ctx: any; offset: [number, number]; layer: any; created: boolean } {
  if (!layerName) {
    const target = tex.getActiveCanvas ? tex.getActiveCanvas() : tex;
    const layer = target !== tex ? target : null;
    return { canvas: target.canvas, ctx: target.ctx, offset: (layer?.offset?.slice() as [number, number]) || [0, 0], layer, created: false };
  }
  enableLayers(tex);
  let layer = findLayer(tex, layerName);
  let created = false;
  if (layer && isGroup(layer)) fail(`"${layer.name}" is a layer GROUP — paint into one of its layers, or pass a new layer name to create one.`);
  if (!layer) {
    layer = createPixelLayer(tex, { name: layerName });
    created = true;
  }
  return { canvas: layer.canvas, ctx: layer.ctx, offset: layer.offset.slice() as [number, number], layer, created };
}

/** Push a finished bitmap edit to the composite, the material and the undo source. */
export function commitBitmap(tex: any) {
  if (!tex.internal) tex.convertToInternal();
  tex.updateChangesAfterEdit();
}

function refreshUi() {
  try { updateInterfacePanels(); } catch { /* panels not mounted */ }
  try { BARS.updateConditions(); } catch { /* toolbar not mounted */ }
  try { UVEditor.vue?.$forceUpdate?.(); } catch { /* UV editor not mounted */ }
}

register('texture_layers', (params) => {
  requireProject();
  const tex = resolveTexture(params.texture);
  const ops: any[] = Array.isArray(params.ops) ? params.ops : [];
  if (!ops.length) return layerTree(tex);

  const OPS = ['enable', 'disable', 'add_layer', 'add_group', 'update', 'delete', 'merge_down', 'ungroup', 'select'];
  ops.forEach((op, i) => {
    if (!OPS.includes(op?.op)) fail(`ops[${i}]: unknown op "${op?.op}". Valid: ${OPS.join(', ')}.`);
    if (op.blend_mode != null && !BLEND_MODES.includes(op.blend_mode)) fail(`ops[${i}]: blend_mode must be one of ${BLEND_MODES.join(', ')}.`);
    if ((op.op === 'add_group' || op.op === 'ungroup') && !hasLayerGroups()) {
      fail(`ops[${i}]: layer groups need Blockbench 5.2 or newer (this is ${Blockbench.version}).`);
    }
  });

  Undo.initEdit({ textures: [tex], bitmap: true });
  const log: string[] = [];
  try {
    for (const op of ops) {
      switch (op.op) {
        case 'enable':
          log.push(enableLayers(tex) ? 'enabled layers (current image became the base layer)' : 'layers were already enabled');
          break;
        case 'disable': {
          if (!tex.layers_enabled) { log.push('layers were already disabled'); break; }
          // The composite canvas already holds the flattened image.
          tex.updateLayerChanges(true);
          tex.layers_enabled = false;
          tex.selected_layer = null;
          tex.layers.empty();
          try { if (UVEditor.vue) UVEditor.vue.layer = null; } catch {}
          log.push('flattened all layers into the texture and disabled layers');
          break;
        }
        case 'add_layer': {
          enableLayers(tex);
          const layer = createPixelLayer(tex, op);
          log.push(`added layer "${layer.name}"`);
          break;
        }
        case 'add_group': {
          enableLayers(tex);
          const group = new TextureLayerGroup({ name: op.name || 'Layer Group' }, tex);
          if (op.parent && op.parent !== 'root') group.parent_uuid = requireGroup(tex, op.parent, 'add_group').uuid;
          else group.parent_uuid = '';
          insertLayer(tex, group, op);
          for (const id of op.layers || []) {
            const child = requireLayer(tex, id, 'add_group.layers');
            if (child === group) continue;
            child.parent_uuid = group.uuid;
          }
          solveOrder(tex);
          log.push(`added group "${group.name}"${op.layers?.length ? ` holding ${op.layers.length} layer(s)` : ''}`);
          break;
        }
        case 'update': {
          const layer = requireLayer(tex, op.layer, 'update');
          if (op.name != null) layer.name = op.name;
          if (op.visible != null) {
            layer.visible = op.visible;
            // A group's visibility is its children's, as in Blockbench's own toggle.
            if (isGroup(layer)) layer.getAllChildren().forEach((c: any) => { if ('visible' in c) c.visible = op.visible; });
          }
          if (!isGroup(layer)) {
            if (op.opacity != null) layer.opacity = toLayerOpacity(op.opacity);
            if (op.blend_mode != null) layer.blend_mode = op.blend_mode;
            if (op.offset) layer.offset.replace([Math.round(op.offset[0]), Math.round(op.offset[1])]);
          } else if (op.opacity != null || op.blend_mode != null || op.offset) {
            fail(`update: "${layer.name}" is a group — opacity, blend_mode and offset belong to its pixel layers.`);
          }
          if (op.parent !== undefined) {
            if (op.parent === null || op.parent === 'root') layer.parent_uuid = '';
            else {
              const parent = requireGroup(tex, op.parent, 'update.parent');
              if (parent === layer || (isGroup(layer) && layer.getAllChildren().includes(parent))) fail(`update: "${layer.name}" cannot be moved into itself.`);
              layer.parent_uuid = parent.uuid;
            }
          }
          if (op.above || op.below || op.index != null) insertLayer(tex, layer, { ...op, parent: op.parent });
          else solveOrder(tex);
          log.push(`updated "${layer.name}"`);
          break;
        }
        case 'delete': {
          const layer = requireLayer(tex, op.layer, 'delete');
          const doomed = isGroup(layer) ? [layer, ...layer.getAllChildren()] : [layer];
          if (tex.layers.filter((l: any) => !doomed.includes(l) && !isGroup(l)).length === 0) {
            fail(`delete: "${layer.name}" holds the last pixel layer of "${tex.name}". Use op "disable" to flatten instead.`);
          }
          doomed.forEach((l: any) => tex.layers.remove(l));
          if (doomed.includes(tex.selected_layer)) tex.selected_layer = tex.layers.find((l: any) => !isGroup(l)) || null;
          log.push(`deleted "${layer.name}"${doomed.length > 1 ? ` and ${doomed.length - 1} nested item(s)` : ''}`);
          break;
        }
        case 'merge_down': {
          const layer = requireLayer(tex, op.layer, 'merge_down');
          if (isGroup(layer)) fail('merge_down: pick a pixel layer, not a group.');
          const below = tex.layers[tex.layers.indexOf(layer) - 1];
          if (!below || isGroup(below)) fail(`merge_down: there is no pixel layer directly below "${layer.name}".`);
          layer.mergeDown(false);
          log.push(`merged "${layer.name}" into "${below.name}"`);
          break;
        }
        case 'ungroup': {
          const group = requireGroup(tex, op.layer, 'ungroup');
          for (const l of tex.layers) if (l.parent_uuid === group.uuid) l.parent_uuid = group.parent_uuid || '';
          tex.layers.remove(group);
          solveOrder(tex);
          log.push(`dissolved group "${group.name}" (its layers moved up one level)`);
          break;
        }
        case 'select': {
          const layer = requireLayer(tex, op.layer, 'select');
          tex.selected_layer = layer;
          tex.layers.forEach((l: any) => { l.multi_selected = l === layer; });
          log.push(`"${layer.name}" is now the active layer (Blockbench's brush and untargeted paint ops draw on it)`);
          break;
        }
      }
    }
    if (tex.layers_enabled) tex.updateLayerChanges(true);
    else tex.updateChangesAfterEdit();
    tex.saved = false;
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  Undo.finishEdit('MCP: Texture layers', { textures: [tex], bitmap: true });
  refreshUi();
  return { ...layerTree(tex), applied: log };
});
