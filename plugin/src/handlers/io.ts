// Export / import: every codec Blockbench ships, without dialogs.
import { register, fail, requireProject } from '../registry';
import { resolveAnimation } from '../util';

const EXPORT_FORMATS: Record<string, { codec: () => any; extension: string; options?: any; note?: string }> = {
  bbmodel: { codec: () => Codecs.project, extension: 'bbmodel' },
  bedrock_geo: { codec: () => Codecs.bedrock, extension: 'json', note: 'Bedrock geometry (.geo.json). Merges into the target file if it already contains other geometries.' },
  java_block: { codec: () => Codecs.java_block, extension: 'json' },
  gltf: { codec: () => Codecs.gltf, extension: 'gltf', options: { encoding: 'ascii' } },
  glb: { codec: () => Codecs.gltf, extension: 'glb', options: { encoding: 'binary' } },
  obj: { codec: () => Codecs.obj, extension: 'obj', note: 'Also writes .mtl and texture files next to the .obj.' },
  fbx: { codec: () => Codecs.fbx, extension: 'fbx' },
  dae: { codec: () => Codecs.collada, extension: 'dae' },
  stl: { codec: () => Codecs.stl, extension: 'stl' },
  optifine_jem: { codec: () => Codecs.optifine_entity, extension: 'jem' },
};

register('export_model', async (params) => {
  requireProject();
  const format = params.format;
  const spec = EXPORT_FORMATS[format];
  if (!spec) fail(`Unknown export format "${format}". Valid: ${Object.keys(EXPORT_FORMATS).join(', ')}`);
  const codec = spec.codec();
  if (!codec) fail(`The codec for "${format}" is not available in this Blockbench instance.`);
  if (!params.path) fail(`Pass an absolute output "path" (should end in .${spec.extension}).`);

  const options = { ...(spec.options || {}), ...(params.options || {}) };
  let content = codec.compile(Object.keys(options).length ? options : undefined);
  if (content instanceof Promise) content = await content;
  codec.write(content, params.path);
  const size = typeof content === 'string' ? content.length : (content?.byteLength ?? 0);
  return { exported: format, path: params.path, bytes: size, note: spec.note };
});

register('get_model_json', async (params) => {
  requireProject();
  const format = params.format || 'bedrock_geo';
  const spec = EXPORT_FORMATS[format];
  if (!spec) fail(`Unknown format "${format}". Valid: ${Object.keys(EXPORT_FORMATS).join(', ')}`);
  const codec = spec.codec();
  let content = codec.compile({ ...(spec.options || {}), ...(params.options || {}) });
  if (content instanceof Promise) content = await content;
  if (typeof content !== 'string') fail(`Format "${format}" produces binary output — use project_file action "export" with a path instead.`);
  const maxLength = params.max_length ?? 60000;
  const truncated = content.length > maxLength;
  return {
    format,
    length: content.length,
    truncated,
    content: truncated ? content.slice(0, maxLength) + '\n... [truncated]' : content,
  };
});

register('export_animations', (params) => {
  requireProject();
  if (!Format.animation_mode) fail(`Format "${Format.id}" has no animations.`);
  if (!params.path) fail('Pass an absolute output "path" (e.g. C:/.../model.animation.json).');
  const animations = Array.isArray(params.animations) && params.animations.length
    ? params.animations.map((id: string) => resolveAnimation(id))
    : Animation.all;
  if (!animations.length) fail('There are no animations to export. Create one with create_animation.');
  const codec = AnimationCodec.codecs.bedrock;
  if (!codec) fail('Bedrock animation codec unavailable.');
  const compiled = codec.compileFile(animations);
  Blockbench.writeFile(params.path, { content: JSON.stringify(compiled, null, '\t') });
  animations.forEach((a: any) => { a.path = params.path; a.saved = true; });
  return { exported: animations.map((a: any) => a.name), path: params.path };
});

register('import_model', async (params) => {
  if (!params.path) fail('Missing absolute "path" to a model file.');
  const content: string = await new Promise((resolve, reject) => {
    try {
      Blockbench.read([params.path], { readtype: 'text', errorbox: false }, (files: any[]) => resolve(files[0].content));
    } catch (err) { reject(err); }
  });
  if (params.merge && Project) {
    // Merge bedrock geometry into the current project
    let model;
    try { model = JSON.parse(content); } catch { fail('File is not valid JSON — merge import supports bedrock .geo.json.'); }
    Codecs.bedrock.parse(model, params.path, { import_to_current_project: true });
    return { imported: params.path, mode: 'merge', format: Format.id };
  }
  loadModelFile({ path: params.path, name: PathModule.basename(params.path), content });
  if (!Project) fail('Blockbench did not recognize this file format.');
  return { imported: params.path, mode: 'new_project', format: Format.id, project: Project.uuid };
});
