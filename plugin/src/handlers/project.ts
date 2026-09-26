// Project lifecycle: create, inspect, settings, open/save/close, tabs.
import { register, fail, requireProject } from '../registry';
import { describeTexture, systemPaths } from '../util';

const FORMAT_NOTES: Record<string, string> = {
  free: 'Generic model. Most flexible: meshes, armatures, animations, per-texture UV size. Animations are saved inside the .bbmodel only.',
  bedrock: 'Minecraft Bedrock entity (.geo.json). Cubes only, groups act as bones, animations export to .animation.json.',
  bedrock_block: 'Minecraft Bedrock block/item geometry. No animations. Has display transforms and a 30x30x30 size limit.',
  java_block: 'Minecraft Java block/item model. Cubes only, no bone rig, rotation limited to 22.5-degree steps on one axis (per element) unless targeting 1.21.11+. java_block_version 26.3 adds per-cube shade_direction_override. Display transforms supported.',
  modded_entity: 'Java Edition modded entity class export (1.12-1.17 templates). Box UV, bones, animations resolved to code.',
  optifine_entity: 'OptiFine JEM entity model.',
  skin: 'Minecraft skin / entity texture editor. create_project takes "skin_model" (steve, alex, cushion, any mob...) and builds that template with a texture to paint.',
  image: '2D image editing format.',
};

function formatInfo(format: any) {
  return {
    id: format.id,
    name: format.name,
    notes: FORMAT_NOTES[format.id],
    capabilities: {
      animation_mode: !!format.animation_mode,
      animation_files: !!format.animation_files,
      bone_rig: !!format.bone_rig,
      box_uv: !!format.box_uv,
      optional_box_uv: !!format.optional_box_uv,
      single_texture: !!format.single_texture,
      per_texture_uv_size: !!format.per_texture_uv_size,
      meshes: !!format.meshes,
      locators: !!format.locators,
      rotate_cubes: !!format.rotate_cubes,
      rotation_limit: !!format.rotation_limit,
      display_mode: !!format.display_mode,
      centered_grid: !!format.centered_grid,
      texture_meshes: !!format.texture_meshes,
      armature_rig: !!format.armature_rig,
      bounding_boxes: !!format.bounding_boxes,
    },
  };
}

register('list_formats', () => {
  return Object.keys(Formats).map((id) => formatInfo(Formats[id]));
});

/**
 * Skin/entity templates (steve, alex, every mob, 5.2's "cushion", ...) are only
 * reachable through the skin format's own New dialog — the preset table is
 * module-private. Drive that dialog so the result matches File > New exactly,
 * including the generated texture template.
 */
function createSkinProject(params: any) {
  Formats.skin.new();
  const dialog: any = Dialog.open;
  if (!dialog || dialog.id !== 'skin') fail('The skin model dialog did not open — cannot pick a skin template.');
  const options: Record<string, string> = dialog.form_config?.model?.options || {};
  const model = params.skin_model || 'steve';
  if (!options[model] || model === 'flat_texture') {
    dialog.cancel();
    const valid = Object.keys(options).filter((k) => k !== 'flat_texture');
    fail(`Unknown skin_model "${model}". Available templates (${valid.length}): ${valid.join(', ')}. For a plain 2D texture use format "image".`);
  }
  const values: any = { model, texture_source: 'template', resolution: params.skin_resolution ?? 1, pose: params.skin_pose !== false, layer_template: false };
  if (params.skin_edition) values.game_edition = params.skin_edition === 'bedrock' ? 'bedrock_edition' : 'java_edition';
  if (params.skin_variant) values.variant = params.skin_variant;
  dialog.setFormValues(values, true);
  dialog.confirm();
  if (!Project || Format.id !== 'skin') fail(`Creating the "${model}" skin project failed.`);
}

register('create_project', (params) => {
  const id = params.format || 'bedrock';
  const format = Formats[id];
  if (!format) {
    fail(`Unknown format "${id}". Available formats: ${Object.keys(Formats).join(', ')}`);
  }
  if (params.skin_model && id !== 'skin') fail('"skin_model" only applies to format "skin".');
  if (id === 'skin') createSkinProject(params);
  else newProject(format);
  if (params.name) {
    Project.name = params.name;
    if (Format.model_identifier) {
      Project.model_identifier = params.model_identifier || params.name.toLowerCase().replace(/[^a-z0-9._]/g, '_');
    }
  }
  if (params.texture_width) Project.texture_width = params.texture_width;
  if (params.texture_height) Project.texture_height = params.texture_height;
  return {
    uuid: Project.uuid,
    name: Project.name,
    format: Format.id,
    skin_model: Format.id === 'skin' ? Project.skin_model : undefined,
    texture_size: [Project.texture_width, Project.texture_height],
    bones: Format.id === 'skin' ? getAllGroups().map((g: any) => g.name) : undefined,
    format_capabilities: formatInfo(Format).capabilities,
  };
});

const CONVENTIONS = {
  units: '1 unit = 1/16 block; a standard block is 16x16x16. Y is up, ground plane is y=0.',
  axes: '+X = east, +Z = south, -Z = north. Entities are conventionally modeled facing NORTH (-Z); the "north" camera preset shows the front.',
  rotation: 'Degrees, Euler order ZYX (X applied first, then Y, then Z — matches Minecraft/Bedrock). +X swings a hanging limb FORWARD (toward -Z). +Y yaws counterclockwise seen from above (east turns toward north). +Z rolls the top toward west.',
  animation: 'Keyframe rotation channels use the same convention, rotating around the bone (group) origin/pivot.',
};

register('get_project_info', () => {
  requireProject();
  const groups = getAllGroups();
  return {
    conventions: CONVENTIONS,
    uuid: Project.uuid,
    name: Project.name,
    model_identifier: Project.model_identifier,
    format: formatInfo(Format),
    mode: Mode.selected?.id,
    texture_size: [Project.texture_width, Project.texture_height],
    box_uv: Project.box_uv,
    save_path: Project.save_path || undefined,
    export_path: Project.export_path || undefined,
    paths: systemPaths(true),
    saved: Project.saved,
    counts: {
      cubes: Cube.all.length,
      meshes: Mesh.all.length,
      groups: groups.length,
      locators: Project.elements.filter((e: any) => e.type === 'locator').length,
      ik_controllers: Project.elements.filter((e: any) => e.type === 'null_object' && e.ik_target).length || undefined,
      bounding_boxes: Project.elements.filter((e: any) => e.type === 'bounding_box').length || undefined,
      textures: Texture.all.length,
      animations: Animation.all.length,
    },
    bones: groups.map((g: any) => ({
      name: g.name,
      uuid: g.uuid,
      parent: g.parent === 'root' ? 'root' : g.parent.name,
    })),
    textures: Texture.all.map(describeTexture),
    animations: Animation.all.map((a: any) => ({ uuid: a.uuid, name: a.name, length: a.length, loop: a.loop })),
    open_tabs: ModelProject.all.map((p: any) => ({ uuid: p.uuid, name: p.getDisplayName(), selected: p.selected })),
  };
});

register('set_project_settings', (params) => {
  requireProject();
  const changed: string[] = [];
  if (params.name != null) { Project.name = params.name; changed.push('name'); }
  if (params.model_identifier != null) { Project.model_identifier = params.model_identifier; changed.push('model_identifier'); }
  if (params.ambientocclusion != null) { Project.ambientocclusion = params.ambientocclusion; changed.push('ambientocclusion'); }
  if (params.front_gui_light != null) { Project.front_gui_light = params.front_gui_light; changed.push('front_gui_light'); }
  if (params.visible_box != null) { Project.visible_box = params.visible_box; changed.push('visible_box'); }
  if (params.java_block_version != null) { Project.java_block_version = params.java_block_version; changed.push('java_block_version'); }
  if (params.bedrock_animation_mode != null) { Project.bedrock_animation_mode = params.bedrock_animation_mode; changed.push('bedrock_animation_mode'); }
  if (params.texture_width != null || params.texture_height != null) {
    const width = params.texture_width ?? Project.texture_width;
    const height = params.texture_height ?? Project.texture_height;
    UVSizeUtil.adjustProjectResolution(width, height, params.modify_uv === true);
    changed.push('texture_size');
  }
  if (!changed.length) fail('No settings provided. Pass at least one of: name, model_identifier, texture_width/texture_height, ambientocclusion, front_gui_light, visible_box, java_block_version, bedrock_animation_mode.');
  return { changed, name: Project.name, texture_size: [Project.texture_width, Project.texture_height] };
});

register('open_project', async (params) => {
  if (!params.path) fail('Missing path to a model file (.bbmodel, .geo.json, block model .json, .jem, ...).');
  const content: string = await new Promise((resolve, reject) => {
    try {
      Blockbench.read([params.path], { readtype: 'text', errorbox: false }, (files: any[]) => {
        resolve(files[0].content);
      });
    } catch (err) { reject(err); }
  });
  loadModelFile({ path: params.path, name: PathModule.basename(params.path), content });
  requireProject();
  return { uuid: Project.uuid, name: Project.name, format: Format.id };
});

register('save_project', (params) => {
  requireProject();
  const path = params.path || Project.save_path;
  if (!path) fail('Project has no save path yet. Pass an absolute "path" ending in .bbmodel.');
  if (!/\.bbmodel$/i.test(path)) fail('save_project writes the Blockbench project file — path must end in .bbmodel. Use export_model for other formats.');
  const content = Codecs.project.compile();
  Codecs.project.write(content, path);
  return { saved: true, path };
});

register('select_project_tab', (params) => {
  const project = ModelProject.all.find((p: any) => p.uuid === params.uuid)
    || ModelProject.all.find((p: any) => p.name === params.uuid || p.getDisplayName() === params.uuid);
  if (!project) fail(`No open project tab matches "${params.uuid}". Open tabs: ${ModelProject.all.map((p: any) => `${p.getDisplayName()} (${p.uuid})`).join(', ') || 'none'}`);
  const ok = project.select();
  if (!ok) fail('Could not select that project tab (it may be locked).');
  return { selected: project.uuid, name: project.getDisplayName() };
});

register('close_project', async (params) => {
  requireProject();
  const name = Project.getDisplayName();
  const closed = await Project.close(params.force === true);
  if (!closed) fail('Project was not closed — it has unsaved changes. Pass force: true to discard them, or save_project first.');
  return { closed: name };
});
