// Blockbench MCP bridge plugin. File name must stay `blockbench_mcp.js`
// (plugin id == file name). Import side-effects register all command handlers.
import { installUnthrottledTimers, uninstallUnthrottledTimers } from './timers';
import './handlers/project';
import './handlers/symmetry';
import './handlers/elements';
import './handlers/geometry';
import './handlers/textures';
import './handlers/layers';
import './handlers/uv';
import './handlers/unwrap';
import './handlers/meshedit';
import './handlers/meshgen';
import './handlers/bake';
import './handlers/palette';
import './handlers/reference';
import './handlers/record';
import { stopRecording } from './handlers/record';
import './handlers/animation';
import './handlers/rigging';
import './handlers/camera';
import './handlers/scene';
import './handlers/io';
import './handlers/pixelart';
import './handlers/misc';
import { connect, shutdown, restart, connectionState } from './socket';
import { listCommands } from './registry';

const deletables: any[] = [];
function reg<T>(item: T): T {
  deletables.push(item);
  return item;
}

Plugin.register('blockbench_mcp', {
  title: 'Blockbench MCP Bridge',
  author: 'BlockBenchMCP',
  description: 'Lets AI assistants control Blockbench through the Model Context Protocol: modeling, texturing, UV, rigged & group animations, rendering, pixel-art sprite export and model export.',
  icon: 'hub',
  version: '1.7.1',
  variant: 'desktop',
  min_version: '5.0.0',
  tags: ['Interface', 'MCP'],
  onload() {
    // Before anything else: Chromium throttles timers to ~1/second in a hidden
    // window, which stalls every Blockbench operation that yields through
    // setTimeout (texture templates above all). See plugin/src/timers.ts.
    if (!installUnthrottledTimers()) {
      console.warn('[MCP] Node timers unavailable — long operations will be slow while the Blockbench window is hidden.');
    }

    reg(new Setting('mcp_bridge_port', {
      name: 'MCP Bridge Port',
      description: 'Port of the local MCP server the bridge connects to. Must match the MCP server (default 8188).',
      category: 'general',
      type: 'number',
      value: 8188,
      min: 1024,
      max: 65535,
      onChange() {
        restart();
      },
    }));

    const statusDialog = reg(new Dialog('mcp_bridge_status', {
      title: 'MCP Bridge Status',
      singleButton: true,
      lines: ['<div id="mcp_bridge_status_content" style="min-width: 300px; padding: 8px 0;"></div>'],
      onOpen() {
        const el = (this as any).object.querySelector('#mcp_bridge_status_content');
        const state = connectionState();
        el.innerHTML = `
          <p><b>Connection:</b> ${state === 'connected' ? '🟢 Connected to MCP server' : `🔴 ${state} — is the MCP server running? (Claude Desktop starts it automatically)`}</p>
          <p><b>Port:</b> ${Settings.get('mcp_bridge_port') || 8188}</p>
          <p><b>Commands available:</b> ${listCommands().length}</p>`;
      },
    }));

    const action = reg(new Action('mcp_bridge_status_action', {
      name: 'MCP Bridge Status',
      description: 'Show the MCP bridge connection status',
      icon: 'hub',
      category: 'tools',
      click() {
        statusDialog.show();
      },
    }));
    MenuBar.addAction(action, 'tools');

    connect();
  },
  onunload() {
    shutdown();
    uninstallUnthrottledTimers();
    stopRecording();
    deletables.forEach((d) => d.delete?.());
    deletables.length = 0;
  },
});
