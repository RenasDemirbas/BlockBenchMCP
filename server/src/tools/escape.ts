// Escape hatches: raw actions, eval, undo/redo.
import { z } from 'zod';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forward } from '../respond';
import { mutating, destructive } from './shared';

export function registerEscapeTools(server: McpServer) {
  server.registerTool('run_action', {
    title: 'Run Blockbench action',
    description: 'Trigger any built-in Blockbench action by id (menu items, tools). Escape hatch for features without a dedicated tool. Errors suggest similar ids if not found.',
    inputSchema: {
      id: z.string().describe('Action id, e.g. "screenshot_model"'),
      confirm_dialog: z.boolean().optional().describe('Auto-confirm a dialog the action opens'),
      dialog_values: z.record(z.string(), z.any()).optional().describe('Form values to fill before confirming'),
    },
    annotations: mutating,
  }, forward('run_action'));

  server.registerTool('eval_code', {
    title: 'Run JavaScript in Blockbench',
    description: 'Execute raw JavaScript inside Blockbench with full API access (Project, Cube, Group, Mesh, Animation, Texture, Undo, Canvas, Codecs, THREE...). The ultimate escape hatch when no dedicated tool fits. Wrapped in an undo step by default; returned promises are awaited. The value of the last expression is returned, and a top-level "return" or "await" works too (the code is auto-wrapped in an async function when needed — no manual IIFE). Return a "data:image/..." string (or {__image}/{__images: [...]}) to get real images back. Large results: pass "result_file" to write the full result to disk, or raise "max_length" (default 30000 chars, truncated beyond).\n\nDO NOT require() Node modules. Blockbench gates fs/os/process/child_process/net/https/shell/... behind a SYNCHRONOUS NATIVE MODAL permission dialog that freezes the whole app — and it is invisible while the Blockbench window is minimised, so the app just appears hung and this bridge dies. Such calls are refused before the code runs. You do not need them: filesystem paths come from get_status/get_project_info ("paths") or the SystemInfo global, file writing from Blockbench.writeFile(path, {content}) or this tool\'s "result_file", reading from Blockbench.read(), path joining from the PathModule global. Only path, crypto, events, zlib, timers, url, string_decoder, querystring, constants, buffer, stream and perf_hooks load without a prompt.\n\nUse sparingly and prefer dedicated tools (query_geometry/validate_model cover most world-space math; get_texture crops to a single face).',
    inputSchema: {
      code: z.string(),
      undo: z.boolean().optional().describe('false disables undo wrapping'),
      result_file: z.string().optional().describe('Absolute path — write the full serialized result here instead of returning it inline'),
      max_length: z.number().optional().describe('Inline result character limit before truncation, default 30000'),
      allow_native_modules: z.boolean().optional().describe('Opt out of the require() guard. Only with the Blockbench window in the FOREGROUND — a permission modal will block the app until a human answers it.'),
    },
    annotations: destructive,
  }, forward('eval_code', 60_000));

  server.registerTool('undo', {
    title: 'Undo',
    description: 'Undo the last edit(s) in Blockbench. All MCP edits are undoable.',
    inputSchema: { steps: z.number().optional() },
    annotations: mutating,
  }, forward('undo'));

  server.registerTool('redo', {
    title: 'Redo',
    description: 'Redo previously undone edit(s).',
    inputSchema: { steps: z.number().optional() },
    annotations: mutating,
  }, forward('redo'));
}
