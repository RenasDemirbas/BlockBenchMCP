// Tool-result formatting: JSON text + inline images extracted from bridge payloads.
import { call } from './bridge';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

function dataUrlToImage(dataUrl: string): ContentBlock | null {
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { type: 'image', data: match[2], mimeType: match[1] };
}

/** Convert a bridge result ({__image, __images} magic keys) into MCP content. */
export function toToolResult(result: any): ToolResult {
  const content: ContentBlock[] = [];
  let payload = result;
  if (payload && typeof payload === 'object') {
    const { __image, __images, ...rest } = payload;
    payload = rest;
    const images: string[] = [...(__image ? [__image] : []), ...(__images || [])];
    for (const dataUrl of images) {
      const block = dataUrlToImage(dataUrl);
      if (block) content.push(block);
    }
  }
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  content.unshift({ type: 'text', text: text ?? 'done' });
  return { content };
}

export function errorResult(err: any): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }],
    isError: true,
  };
}

/** Standard handler: forward to the plugin command of the same name. */
export function forward(command: string, timeoutMs?: number) {
  return async (params: any): Promise<ToolResult> => {
    try {
      const result = await call(command, params ?? {}, timeoutMs);
      return toToolResult(result);
    } catch (err) {
      return errorResult(err);
    }
  };
}
