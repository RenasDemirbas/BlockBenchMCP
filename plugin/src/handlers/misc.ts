// Display transforms, actions, eval escape hatch, undo/redo, status.
import { register, fail, requireProject, listCommands } from '../registry';
import { PLUGIN_VERSION } from '../socket';
import { timerStatus } from '../timers';
import { systemPaths } from '../util';

const DISPLAY_SLOTS = ['thirdperson_righthand', 'thirdperson_lefthand', 'firstperson_righthand', 'firstperson_lefthand', 'ground', 'gui', 'head', 'fixed'];

register('set_display_transforms', (params) => {
  requireProject();
  if (!Format.display_mode) {
    fail(`Format "${Format.id}" has no display transforms. They exist in java_block and bedrock_block formats (how the item looks in hand/gui/ground).`);
  }
  const slot = params.slot;
  if (!DISPLAY_SLOTS.includes(slot)) fail(`Invalid slot "${slot}". Valid: ${DISPLAY_SLOTS.join(', ')}`);
  Undo.initEdit({ display_slots: [slot] });
  if (!Project.display_settings[slot]) Project.display_settings[slot] = new DisplaySlot(slot);
  const data: any = {};
  if (params.rotation) data.rotation = params.rotation;
  if (params.translation) data.translation = params.translation;
  if (params.scale) data.scale = params.scale;
  if (params.mirror) data.mirror = params.mirror;
  Project.display_settings[slot].extend(data);
  Project.display_settings[slot].update?.();
  Undo.finishEdit('MCP: Edit display transforms', { display_slots: [slot] });
  return {
    slot,
    rotation: Project.display_settings[slot].rotation.slice(),
    translation: Project.display_settings[slot].translation.slice(),
    scale: Project.display_settings[slot].scale.slice(),
  };
});

register('get_display_transforms', () => {
  requireProject();
  if (!Format.display_mode) fail(`Format "${Format.id}" has no display transforms.`);
  const out: any = {};
  for (const slot of DISPLAY_SLOTS) {
    const s = Project.display_settings[slot];
    if (s) out[slot] = { rotation: s.rotation.slice(), translation: s.translation.slice(), scale: s.scale.slice() };
  }
  return out;
});

register('run_action', (params) => {
  if (!params.id) fail('Pass the "id" of a Blockbench action (BarItems id), e.g. "add_cube", "screenshot_model".');
  const action = BarItems[params.id];
  if (!action) {
    const search = String(params.id).toLowerCase();
    const similar = Object.keys(BarItems).filter((k) => k.toLowerCase().includes(search)).slice(0, 12);
    fail(`Unknown action "${params.id}".${similar.length ? ` Did you mean: ${similar.join(', ')}` : ''}`);
  }
  if (typeof action.trigger === 'function') action.trigger();
  else if (typeof action.click === 'function') action.click();
  else fail(`Action "${params.id}" is not triggerable (type: ${action.constructor?.name}).`);
  // Auto-confirm a dialog the action may have opened
  if (params.confirm_dialog && Dialog.open) {
    if (params.dialog_values) {
      try { Dialog.open.setFormValues(params.dialog_values, true); } catch {}
    }
    Dialog.open.confirm();
  }
  return { triggered: params.id, dialog_open: !!Dialog.open };
});

// Blockbench's plugin-scoped require (js/native_apis.ts) splits Node modules in
// two: SAFE_APIS load silently, everything else goes through
// `dialog.showMessageBoxSync` — a SYNCHRONOUS NATIVE MODAL. It blocks the whole
// renderer until a human clicks a button, and when the Blockbench window is
// minimised (the normal state for MCP work) nobody can see it. That is the
// "eval_code froze Blockbench for 8 minutes and killed the bridge" failure:
// not a runaway loop, a modal waiting offscreen. No JS-side timeout can rescue
// it, so the guard has to run BEFORE the code does.
const SAFE_NODE_MODULES = [
  'path', 'crypto', 'events', 'zlib', 'timers', 'url',
  'string_decoder', 'querystring', 'constants', 'buffer', 'stream', 'perf_hooks',
];
const PROMPTING_NODE_MODULES = [
  'fs', 'process', 'child_process', 'https', 'net', 'tls',
  'util', 'os', 'v8', 'dialog', 'clipboard', 'shell',
];

/** Every require()/requireNativeModule() call site in the code, literal or not. */
function scanRequires(code: string): { module: string | null }[] {
  const found: { module: string | null }[] = [];
  const re = /\b(?:require|requireNativeModule)\s*\(\s*(?:(['"`])([^'"`]*)\1)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) found.push({ module: m[2] ?? null });
  return found;
}

function guardNativeModules(code: string, allow: boolean) {
  if (allow) return;
  for (const { module } of scanRequires(code)) {
    const name = module == null ? null : module.replace(/^node:/, '');
    if (name != null && SAFE_NODE_MODULES.includes(name)) continue;
    const what = name == null ? 'require() with a computed module name' : `require("${module}")`;
    const why = name != null && !PROMPTING_NODE_MODULES.includes(name)
      ? `Blockbench does not support that module at all — the call throws.`
      : `Blockbench asks for permission through a SYNCHRONOUS NATIVE MODAL (dialog.showMessageBoxSync). It freezes the entire app — including this bridge — until someone clicks a button, and the dialog is invisible while the Blockbench window is minimised. Recovering means alt-tabbing to Blockbench by hand; unsaved work is at risk.`;
    fail(
      `eval_code refused to run: ${what}. ${why}\n`
      + `You almost certainly do not need it:\n`
      + `  • filesystem paths (home, desktop, temp, appdata, user data) → the "paths" block of get_status / get_project_info, or the global SystemInfo\n`
      + `  • writing a file → Blockbench.writeFile(path, {content}) — or eval_code's own "result_file" param\n`
      + `  • reading a file → Blockbench.read([path], {readtype:"text"}, cb)\n`
      + `  • path joining → the PathModule global (no require needed)\n`
      + `Freely usable without a prompt: ${SAFE_NODE_MODULES.join(', ')}.\n`
      + `If you truly need a native module, bring the Blockbench window to the FOREGROUND first and re-send with "allow_native_modules": true, then answer the permission dialog.`
    );
  }
}

/**
 * Run the code with plain-eval semantics (the value of the last expression is
 * the result), falling back to an async IIFE only when the parser objects to a
 * top-level `return`/`await`. Wrapping unconditionally would silently drop the
 * completion value that expression-style calls rely on; wrapping on demand
 * keeps both styles working. Direct eval is required either way — the
 * plugin-scoped `require` is a wrapper-function argument, not a global, and
 * only direct eval inherits that scope.
 */
function runEval(code: string): any {
  try {
    return eval(code);
  } catch (err: any) {
    // Narrow on purpose: a runtime SyntaxError (JSON.parse, new RegExp) must
    // NOT trigger a re-run of code that already had side effects.
    const wrappable = err instanceof SyntaxError
      && /Illegal return statement|await is only valid/i.test(String(err.message));
    if (!wrappable) throw err;
    return eval('(async () => {\n' + code + '\n})()');
  }
}

register('eval_code', async (params) => {
  if (!params.code) fail('Pass "code" — JavaScript executed inside Blockbench with full API access (Project, Cube, Group, Animation, Texture, Undo, Canvas, Codecs, ...). The value of the last expression is serialized back; a top-level "return" works too. Returned promises are awaited. Return a "data:image/..." string (or {__image}/{__images}) to send an image back.');
  guardNativeModules(String(params.code), params.allow_native_modules === true);
  let result;
  const wrapUndo = params.undo !== false && !!Project;
  if (wrapUndo) Undo.initEdit({ outliner: true, elements: [...Project.elements], groups: [...Project.groups], textures: [...Texture.all], animations: [...Animation.all], selection: true, bitmap: true });
  try {
    result = runEval(params.code);
    if (result instanceof Promise) result = await result;
  } catch (err: any) {
    if (wrapUndo) Undo.cancelEdit(false);
    fail(`eval error: ${err?.message || err}\n${(err?.stack || '').split('\n').slice(0, 4).join('\n')}`);
  }
  // Fresh aspect arrays at finish: anything the eval'd code CREATED must be in
  // the post-save, or undo would leave it behind as an un-deletable ghost.
  if (wrapUndo) {
    Undo.finishEdit('MCP: eval_code', {
      outliner: true,
      elements: [...Project.elements],
      groups: [...Project.groups],
      textures: [...Texture.all],
      animations: [...Animation.all],
      selection: true,
      bitmap: true,
    });
  }

  // Image passthrough: data URLs come back as real MCP image blocks.
  const isImage = (v: any) => typeof v === 'string' && v.startsWith('data:image/');
  if (isImage(result)) {
    return { result: '[image]', __image: result };
  }
  if (result && typeof result === 'object' && (isImage(result.__image) || (Array.isArray(result.__images) && result.__images.every(isImage)))) {
    const { __image, __images, ...rest } = result;
    const out: any = { result: safeJson(rest) };
    if (isImage(__image)) out.__image = __image;
    if (Array.isArray(__images)) out.__images = __images;
    return out;
  }

  let text: string;
  try {
    text = JSON.stringify(result ?? null);
  } catch {
    text = JSON.stringify(String(result));
  }

  // Large results: write to a file instead of flooding the tool result.
  if (params.result_file) {
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    Blockbench.writeFile(params.result_file, { content: pretty });
    return {
      written_to: params.result_file,
      bytes: pretty.length,
      preview: pretty.slice(0, 1000) + (pretty.length > 1000 ? '\n... [see file]' : ''),
    };
  }
  const maxLength = Math.max(200, Math.min(200_000, params.max_length ?? 30_000));
  if (text.length > maxLength) {
    return {
      truncated: true,
      full_length: text.length,
      result_preview: text.slice(0, maxLength),
      note: 'Result truncated. Pass "result_file" (absolute path) to write the full result to disk, or "max_length" to raise the limit.',
    };
  }
  try {
    return { result: JSON.parse(text) };
  } catch {
    return { result: text };
  }
});

function safeJson(value: any): any {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}

register('undo', (params) => {
  requireProject();
  const steps = Math.max(1, Math.min(100, params?.steps ?? 1));
  for (let i = 0; i < steps; i++) Undo.undo();
  return { undone: steps };
});

register('redo', (params) => {
  requireProject();
  const steps = Math.max(1, Math.min(100, params?.steps ?? 1));
  for (let i = 0; i < steps; i++) Undo.redo();
  return { redone: steps };
});

register('get_status', () => {
  return {
    connected: true,
    blockbench_version: Blockbench.version,
    plugin_version: PLUGIN_VERSION,
    project_open: !!Project,
    project: Project ? { uuid: Project.uuid, name: Project.name, format: Format.id, save_path: Project.save_path || null } : null,
    open_tabs: ModelProject.all.map((p: any) => ({ uuid: p.uuid, name: p.getDisplayName(), selected: p.selected })),
    paths: systemPaths(false),
    available_commands: listCommands().length,
    timers: timerStatus(),
  };
});
