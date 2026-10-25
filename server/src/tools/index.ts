// All MCP tool registrations. Handlers forward to the Blockbench plugin over
// the WS bridge; schemas are kept flat (no top-level unions) for maximum
// client compatibility.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerProjectTools } from './project';
import { registerOutlinerTools } from './outliner';
import { registerTextureTools } from './textures';
import { registerUvTools } from './uv';
import { registerAnimationTools } from './animation';
import { registerArmatureTools } from './armature';
import { registerMaterialTools } from './materials';
import { registerDisplayTools } from './display';
import { registerPixelArtTools } from './pixelart';
import { registerEscapeTools } from './escape';

export { syncExternalTools } from './external';

export function registerTools(server: McpServer) {
  registerProjectTools(server);
  registerOutlinerTools(server);
  registerTextureTools(server);
  registerUvTools(server);
  registerAnimationTools(server);
  registerArmatureTools(server);
  registerMaterialTools(server);
  registerDisplayTools(server);
  registerPixelArtTools(server);
  registerEscapeTools(server);
}
