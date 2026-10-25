// Render a capture in one of Blockbench's viewport view modes (textured,
// solid, wireframe, normal, material, weighted_bone_colors ...) and put the
// user's own mode back afterwards.
import { fail } from './registry';

export async function withViewMode<T>(mode: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!mode) return fn();
  const select = BarItems.view_mode;
  if (!select?.options?.[mode]) fail(`Unknown view_mode "${mode}". Valid here: ${Object.keys(select?.options || {}).join(', ')}.`);
  const previous = select.value;
  if (previous === mode) return fn();
  select.change(mode);
  try {
    return await fn();
  } finally {
    select.change(previous);
  }
}
