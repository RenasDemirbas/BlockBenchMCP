// Plugin API check: a tool another Blockbench plugin registers through
// window.BlockbenchMCP.registerTool must appear in tools/list (on the hub and on a
// relay instance), be callable, disappear on delete() and come back through the
// "blockbench_mcp_ready" event after the bridge plugin reloads.
//
// Needs a running Blockbench with the bridge plugin built from this tree. The
// running hub may be an older build, so the plugin is moved to a spare port where
// this build is the hub, and moved back at the end.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(root, 'dist', 'mcp-server.js');
const HOME_PORT = Number(process.env.BB_BRIDGE_PORT || 8188);
const TEST_PORT = 8191;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, BB_BRIDGE_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  let buffer = '';
  let nextId = 1;
  const waiters = new Map();
  const notifications = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
      else if (msg.method) notifications.push(msg.method);
    }
  });
  const rpc = (method, params, timeoutMs = 60000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
      waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  return {
    notifications,
    async init() {
      await sleep(1200); // let the bridge pick hub or client mode
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-plugin-api', version: '0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    },
    async call(name, args = {}) {
      const res = await rpc('tools/call', { name, arguments: args });
      return { text: res.result?.content?.find((c) => c.type === 'text')?.text ?? JSON.stringify(res.error), isError: !!(res.result?.isError || res.error) };
    },
    async tools() {
      return (await rpc('tools/list', {})).result.tools;
    },
    kill: () => child.kill(),
  };
}

const evalCode = (srv, code) => srv.call('eval_code', { code, undo: false });

async function waitFor(label, fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(400);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) failures++;
}

const home = startServer(HOME_PORT);
const hub = startServer(TEST_PORT);
const relay = startServer(TEST_PORT);
let moved = false;

try {
  await home.init();
  await waitFor('Blockbench on the home port', async () => !(await evalCode(home, 'return 1')).isError, 60000);
  await hub.init();
  await relay.init();

  // set() saves the setting and its onChange reconnects — answer first, then switch.
  await evalCode(home, `setTimeout(() => settings.mcp_bridge_port.set(${TEST_PORT}), 200); return 'ok'`);
  moved = true;
  await waitFor('Blockbench on the test port', async () => !(await evalCode(hub, 'return 1')).isError);

  await evalCode(hub, `
    window.__mcpVerify = BlockbenchMCP.registerTool({
      name: 'verify_echo',
      title: 'Verify echo',
      description: 'Echo test tool from verify-plugin-api.mjs',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'what to echo' } }, required: ['text'] },
      annotations: { readOnlyHint: true },
    }, (p) => ({ echo: p.text }));
    return 'ok'`);

  const listed = await waitFor('verify_echo on the hub', async () => (await hub.tools()).find((t) => t.name === 'verify_echo'));
  check('hub lists the tool with its JSON Schema',
    listed.inputSchema?.properties?.text?.description === 'what to echo' && listed.inputSchema?.required?.includes('text'),
    JSON.stringify(listed.inputSchema));
  check('title and annotations pass through', listed.title === 'Verify echo' && listed.annotations?.readOnlyHint === true, JSON.stringify(listed));
  check('hub sent tools/list_changed', hub.notifications.includes('notifications/tools/list_changed'), hub.notifications.join(','));
  check('relay instance lists the tool',
    !!(await waitFor('verify_echo on the relay', async () => (await relay.tools()).find((t) => t.name === 'verify_echo'), 5000).catch(() => null)));

  const viaHub = await hub.call('verify_echo', { text: 'hi' });
  check('call through the hub reaches the handler', !viaHub.isError && viaHub.text.includes('"echo": "hi"'), viaHub.text);
  const viaRelay = await relay.call('verify_echo', { text: 'relay' });
  check('call through the relay reaches the handler', !viaRelay.isError && viaRelay.text.includes('"echo": "relay"'), viaRelay.text);

  const clash = await evalCode(hub, `try { BlockbenchMCP.registerTool({ name: 'eval_code', description: 'x' }, () => 1); return 'no error' } catch (e) { return e.message }`);
  check('a built-in name is refused', clash.text.includes('already taken'), clash.text);
  const badSchema = await evalCode(hub, `try { BlockbenchMCP.registerTool({ name: 'verify_bad', description: 'x', inputSchema: { type: 'array' } }, () => 1); return 'no error' } catch (e) { return e.message }`);
  check('a non-object inputSchema is refused', badSchema.text.includes('must be a JSON Schema'), badSchema.text);

  await evalCode(hub, `window.__mcpVerify.delete(); return 'ok'`);
  check('delete() removes it from the hub',
    !!(await waitFor('verify_echo gone', async () => !(await hub.tools()).some((t) => t.name === 'verify_echo'), 5000).catch(() => null)));
  check('delete() removes it from the relay',
    !!(await waitFor('verify_echo gone (relay)', async () => !(await relay.tools()).some((t) => t.name === 'verify_echo'), 5000).catch(() => null)));

  // A plugin listening for the ready event re-adds its tool after the bridge plugin reloads.
  await evalCode(hub, `
    window.__mcpVerifyAdd = () => { window.__mcpVerify = BlockbenchMCP.registerTool({ name: 'verify_ready', description: 'Ready-event test tool' }, () => 'ready'); window.__mcpVerifyReloaded = true };
    window.addEventListener('blockbench_mcp_ready', window.__mcpVerifyAdd);
    setTimeout(() => Plugins.devReload(), 300);
    return 'ok'`);
  // The reloaded plugin reads the port Blockbench loaded at startup (Settings.stored), not the
  // one set above, so it comes back on the home port: move it again.
  await waitFor('ready event after the reload', async () => (await evalCode(home, 'return !!window.__mcpVerifyReloaded')).text.includes('true'), 20000);
  await evalCode(home, `setTimeout(() => settings.mcp_bridge_port.set(${TEST_PORT}), 200); return 'ok'`);
  const readyTool = await waitFor('verify_ready after reload', async () => (await hub.tools()).find((t) => t.name === 'verify_ready'), 20000).catch(() => null);
  check('ready event re-adds the tool after a reload', !!readyTool);
  if (readyTool) {
    const r = await hub.call('verify_ready');
    check('re-added tool is callable', !r.isError && r.text.includes('ready'), r.text);
  }
} catch (err) {
  check('run', false, err.message);
} finally {
  if (moved) {
    await evalCode(hub, `
      window.removeEventListener('blockbench_mcp_ready', window.__mcpVerifyAdd);
      window.__mcpVerify?.delete();
      delete window.__mcpVerify; delete window.__mcpVerifyAdd; delete window.__mcpVerifyReloaded;
      setTimeout(() => settings.mcp_bridge_port.set(${HOME_PORT}), 200);
      return 'ok'`).catch(() => {});
    const back = await waitFor('Blockbench back on the home port', async () => !(await evalCode(home, 'return 1')).isError).catch(() => false);
    if (!back) {
      console.log(`RESTORE FAILED: set Blockbench > Settings > General > "MCP Bridge Port" back to ${HOME_PORT}.`);
      failures++;
    }
  }
  home.kill(); hub.kill(); relay.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
