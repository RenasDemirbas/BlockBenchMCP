// Outliner queries and edits: list, get, update, delete, duplicate, select.
import { register, fail, requireProject } from '../registry';
import { resolveNode, resolveParent, vec3, describeNode, refreshElements, cancelCreate } from '../util';
import { applyFaceData, checkShadeOverride, applyIkFields } from './elements';

register('list_outline', (params) => {
  requireProject();
  const includeElements = params?.include_elements !== false;
  const maxDepth = params?.max_depth ?? 32;
  const walk = (nodes: any[], depth: number): any[] => {
    const out: any[] = [];
    for (const node of nodes) {
      // Groups, armatures and armature bones all hold children.
      if (node instanceof Group || (includeElements && Array.isArray(node.children) && node.children.length)) {
        const entry: any = describeNode(node);
        entry.children = depth < maxDepth ? walk(node.children, depth + 1) : `[${node.children.length} children]`;
        out.push(entry);
      } else if (includeElements) {
        out.push(describeNode(node));
      }
    }
    return out;
  };
  return {
    format: Format.id,
    texture_size: [Project.texture_width, Project.texture_height],
    root: walk(Outliner.root, 1),
  };
});

register('get_element', (params) => {
  requireProject();
  return describeNode(resolveNode(params.id), true);
});

register('update_elements', (params) => {
  requireProject();
  if (!Array.isArray(params.elements) || !params.elements.length) fail('Pass an "elements" array of {id, ...changes}.');
  const nodes = params.elements.map((def: any) => resolveNode(def.id));
  const elements = nodes.filter((n: any) => n instanceof OutlinerElement);
  const groups = nodes.filter((n: any) => n instanceof Group);
  Undo.initEdit({ elements, groups, outliner: true, selection: true });
  const updated: string[] = [];
  try {
    params.elements.forEach((def: any, i: number) => {
      const node = nodes[i];
      const data: any = {};
      for (const key of ['name', 'origin', 'rotation', 'from', 'to', 'inflate', 'visibility', 'autouv', 'shade', 'mirror_uv', 'uv_offset', 'color', 'box_uv', 'rescale', 'bedrock_binding']) {
        if (def[key] !== undefined) data[key] = def[key];
      }
      if (def.shade_direction_override !== undefined) {
        if (!(node instanceof Cube)) fail(`shade_direction_override applies to cubes; "${node.name}" is a ${node.type}.`);
        data.shade_direction_override = checkShadeOverride(def.shade_direction_override ?? '');
      }
      if (def.function !== undefined) {
        if (typeof BoundingBox === 'undefined' || !(node instanceof BoundingBox)) fail(`"function" applies to bounding boxes; "${node.name}" is a ${node.type}.`);
        data.function = def.function.slice();
      }
      if (Object.keys(data).length) node.extend(data);
      if (def.position !== undefined && node.position) node.position.replace(def.position);
      if (['ik_target', 'ik_source', 'ik_pole', 'lock_ik_target_rotation'].some((k) => def[k] !== undefined)) {
        if (node.type !== 'null_object') fail(`IK settings (ik_target/ik_source/ik_pole/lock_ik_target_rotation) belong to null objects; "${node.name}" is a ${node.type}. Create one with add_ik_controllers.`);
        applyIkFields(node, def);
      }
      if (def.faces && node instanceof Cube) applyFaceData(node, def.faces);
      if (def.vertices && node instanceof Mesh) {
        for (const vkey in def.vertices) {
          if (def.vertices[vkey] === null) delete node.vertices[vkey];
          else node.vertices[vkey] = vec3(def.vertices[vkey]);
        }
      }
      if (def.parent !== undefined) {
        const parent = resolveParent(def.parent);
        node.addTo(parent === 'root' ? 'root' : parent, def.parent_index ?? -1);
      }
      if (def.name !== undefined && node.getTypeBehavior?.('unique_name')) node.createUniqueName();
      updated.push(node.uuid);
    });
  } catch (err) {
    Undo.cancelEdit(true);
    throw err;
  }
  refreshElements(nodes);
  Canvas.updateAllUVs();
  Undo.finishEdit('MCP: Update elements', { elements, groups, outliner: true, selection: true });
  return { updated };
});

register('delete_elements', (params) => {
  requireProject();
  if (!Array.isArray(params.ids) || !params.ids.length) fail('Pass an "ids" array of uuids or names to delete.');
  const nodes = params.ids.map((id: string) => resolveNode(id));
  const elements: any[] = [];
  const groups: any[] = [];
  for (const node of nodes) {
    if (node instanceof Group) {
      groups.push(node);
      node.forEachChild((child: any) => {
        (child.type === 'group' ? groups : elements).push(child);
      });
    } else {
      elements.push(node);
    }
  }
  const animations = Animation.all.filter((a: any) => groups.some((g: any) => a.animators?.[g.uuid]));
  Undo.initEdit({ elements, groups, outliner: true, selection: true, animations });
  for (const node of nodes) {
    if (OutlinerNode.uuids[node.uuid]) node.remove(false);
  }
  updateSelection();
  Undo.finishEdit('MCP: Delete elements', { elements: [], groups: [], outliner: true, selection: true, animations });
  return { deleted: nodes.map((n: any) => n.name) };
});

register('duplicate_elements', (params) => {
  requireProject();
  if (!Array.isArray(params.ids) || !params.ids.length) fail('Pass an "ids" array of uuids or names to duplicate.');
  const offset = params.offset ? vec3(params.offset) : null;
  Undo.initEdit({ outliner: true, elements: [], selection: true });
  const clones: any[] = [];
  try {
    for (const id of params.ids) {
      const node = resolveNode(id);
      const clone = node.duplicate();
      if (params.name && params.ids.length === 1) { clone.name = params.name; clone.createUniqueName?.(); }
      if (offset) {
        const moveNode = (n: any) => {
          if (n instanceof Cube) {
            n.from.forEach((_: number, i: number) => { n.from[i] += offset[i]; n.to[i] += offset[i]; n.origin[i] += offset[i]; });
          } else if (n.origin) {
            n.origin.forEach((_: number, i: number) => { n.origin[i] += offset[i]; });
          } else if (n.position) {
            n.position.forEach((_: number, i: number) => { n.position[i] += offset[i]; });
          }
          if (n.children) n.children.forEach(moveNode);
        };
        moveNode(clone);
      }
      clones.push(clone);
    }
  } catch (err) {
    cancelCreate(clones);
    throw err;
  }
  const flat: any[] = [];
  const collect = (n: any) => { flat.push(n); n.children?.forEach(collect); };
  clones.forEach(collect);
  refreshElements(flat);
  Undo.finishEdit('MCP: Duplicate elements', { outliner: true, elements: flat.filter((n) => n instanceof OutlinerElement), selection: true });
  return { created: clones.map((c) => ({ name: c.name, uuid: c.uuid })) };
});

register('select_elements', (params) => {
  requireProject();
  if (params.mode === 'none') {
    unselectAllElements();
    updateSelection();
    return { selected: 0 };
  }
  if (params.mode === 'all') {
    unselectAllElements();
    Project.elements.forEach((el: any) => el.markAsSelected());
    updateSelection();
    return { selected: Project.elements.length };
  }
  if (!Array.isArray(params.ids) || !params.ids.length) fail('Pass "ids" array, or mode: "all" | "none".');
  unselectAllElements();
  let count = 0;
  for (const id of params.ids) {
    const node = resolveNode(id);
    if (node instanceof Group) { node.multiSelect(); count++; }
    else { node.markAsSelected(); count++; }
  }
  updateSelection();
  return { selected: count };
});

