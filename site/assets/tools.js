// Tool reference: renders data/tools.json (written from the server's tools/list at build time)
// with search and an area filter. #tool_name in the URL opens that tool.
const AREAS = {
  Project: ['get_status', 'blockbench_window', 'list_formats', 'create_project', 'get_project_info', 'set_project_settings', 'project_file'],
  Geometry: ['add_groups', 'add_cubes', 'add_meshes', 'add_mesh_primitive', 'add_loft', 'edit_mesh', 'transform_mesh', 'add_planes', 'add_locators', 'add_bounding_boxes', 'list_outline', 'get_element', 'update_elements', 'delete_elements', 'duplicate_elements', 'mirror_elements', 'select_elements'],
  Texture: ['create_texture', 'generate_texture_template', 'list_textures', 'get_texture', 'import_texture', 'apply_texture', 'paint_texture', 'paint_faces', 'bake_texture', 'blend_seams', 'generate_pbr_map', 'palette', 'texture_layers', 'resize_texture', 'set_texture_resolution', 'delete_texture'],
  UV: ['unwrap_mesh', 'uv'],
  Animation: ['create_animation', 'list_animations', 'get_animation', 'update_animation', 'delete_animation', 'set_keyframes', 'edit_keyframes', 'mirror_keyframes', 'add_effect_keyframes', 'apply_animation_preset', 'variable_placeholders', 'preview_animation', 'render_animation'],
  Rigging: ['add_ik_controllers', 'bake_ik_animation', 'add_armature', 'vertex_weights'],
  Checking: ['validate_model', 'query_geometry', 'capture_screenshot', 'capture_multi_view', 'record_build'],
  Reference: ['compare_reference', 'project_reference', 'preview_models', 'reference_images'],
  'Pixel art': ['pixel_art'],
  Display: ['display_transforms'],
  Other: ['run_action', 'eval_code', 'undo', 'redo'],
};
const areaOf = (name) => Object.keys(AREAS).find((a) => AREAS[a].includes(name)) ?? 'Other';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function typeOf(s) {
  if (!s) return '';
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.anyOf) return s.anyOf.map(typeOf).join(' | ');
  if (s.type === 'array') return `${typeOf(s.items) || 'any'}[]`;
  return s.type ?? 'any';
}

/** Parameter rows, nested objects (and arrays of objects) indented under their parent. */
function rows(schema, depth = 0, out = []) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  for (const [key, s] of Object.entries(props)) {
    const inner = s.type === 'array' && s.items?.type === 'object' ? s.items : s.type === 'object' ? s : null;
    out.push(`<tr><td style="padding-left:${13 + depth * 18}px">${esc(key)}${required.has(key) ? ' <span title="required">*</span>' : ''}</td>`
      + `<td><span class="type">${esc(inner ? (s.type === 'array' ? 'object[]' : 'object') : typeOf(s))}</span>${s.description ? `<br>${esc(s.description)}` : ''}</td></tr>`);
    if (inner && depth < 3) rows(inner, depth + 1, out);
  }
  return out;
}

function render(tool) {
  const params = rows(tool.input);
  const firstLine = tool.description.split(/(?<=\.)\s|\n/)[0];
  return `<details class="tool" id="${esc(tool.name)}" data-area="${esc(tool.area)}">
  <summary><b>${esc(tool.name)}</b><span>${esc(firstLine)}</span>
    <span class="tags"><span class="tag">${esc(tool.area)}</span>${tool.readOnly ? '<span class="tag ro">read-only</span>' : ''}${tool.destructive ? '<span class="tag">can discard</span>' : ''}</span></summary>
  <div class="body">
    <p class="desc">${esc(tool.description)}</p>
    ${params.length ? `<div class="table-wrap params"><table><tr><th>Parameter</th><th>Type and meaning</th></tr>${params.join('')}</table></div>` : '<p class="muted">No parameters.</p>'}
  </div>
</details>`;
}

async function main() {
  const list = document.getElementById('tool-list');
  const search = document.getElementById('tool-search');
  const area = document.getElementById('tool-area');
  const count = document.getElementById('tool-count');
  let data;
  try {
    data = await (await fetch('../data/tools.json')).json();
  } catch {
    list.innerHTML = '<p>The tool list could not be loaded. See the <a href="https://github.com/RenasDemirbas/BlockBenchMCP#tools">README</a>.</p>';
    return;
  }
  const order = Object.values(AREAS).flat();
  const tools = data.tools
    .map((t) => ({ ...t, area: areaOf(t.name), haystack: JSON.stringify([t.name, t.description, t.input]).toLowerCase() }))
    .sort((a, b) => (order.indexOf(a.name) + 1 || 999) - (order.indexOf(b.name) + 1 || 999));
  for (const a of Object.keys(AREAS)) area.insertAdjacentHTML('beforeend', `<option>${esc(a)}</option>`);
  list.innerHTML = tools.map(render).join('');
  const nodes = [...list.querySelectorAll('.tool')];

  const apply = () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    nodes.forEach((node, i) => {
      const visible = (!area.value || tools[i].area === area.value) && (!q || tools[i].haystack.includes(q));
      node.hidden = !visible;
      if (visible) shown++;
    });
    count.textContent = `${shown} of ${tools.length}`;
  };
  search.addEventListener('input', apply);
  area.addEventListener('change', apply);
  apply();

  const open = () => {
    const target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target?.classList.contains('tool')) { target.open = true; target.scrollIntoView({ block: 'start' }); }
  };
  addEventListener('hashchange', open);
  open();
}

main();
