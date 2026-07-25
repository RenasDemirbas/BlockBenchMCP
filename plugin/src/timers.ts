// Keeps Blockbench's async work moving while its window is hidden.
//
// THE PROBLEM. Blockbench drives long operations by cooperatively yielding to
// the event loop, e.g. TextureGenerator.generateTemplate:
//
//     await new Promise(resolve => setTimeout(resolve, 1));
//
// Chromium aligns timer wake-ups in a HIDDEN page to roughly one per second
// (and throttles nested timers harder still once the page has been hidden for a
// few minutes). Measured live in Blockbench 5.1.6 with the window minimized, a
// six-link setTimeout(…, 1) chain fired at 481, 484, 1481, 1484, 2480, 2482 ms.
// So every yield costs ~1s, and a 330-face texture template needs minutes
// instead of milliseconds — the MCP call times out long before it finishes.
// Nothing about this scales with the workload, which is why lowering
// pixel_density never helped: the cost is one second per YIELD, not per face.
//
// THE FIX. Node's `timers` module runs on libuv rather than Blink's throttled
// task queues, so it keeps real delays regardless of window state (verified:
// a chained 30 ms Node timer fired every 31 ms while hidden). Blockbench hands
// each plugin a scoped `require` and lists 'timers' as a free module, so no
// permission prompt is involved.
//
// We only reroute while document.hidden is true. With the window in front
// Chromium does not throttle anything, so native timers stay in charge and the
// user's interactive session keeps Chromium's exact semantics (including its
// nested-timeout clamping). The trade-off is that Blockbench's own background
// timers also run at full speed while minimized — that is the point: the window
// being hidden is the normal case when an assistant is driving the app.

type Kind = 'timeout' | 'interval';

const native = {
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  setInterval: window.setInterval.bind(window),
  clearInterval: window.clearInterval.bind(window),
};

// null = not probed yet, false = unavailable.
let nodeTimers: any = null;

function getNodeTimers(): any {
  if (nodeTimers !== null) return nodeTimers;
  nodeTimers = false;
  try {
    // Direct eval on purpose. Blockbench deletes window.require and passes each
    // plugin its own scoped require as an argument of the wrapper function, so
    // this bundle's scope chain is the only way to reach it.
    // eslint-disable-next-line no-eval
    const scopedRequire = eval('typeof require === "function" ? require : null');
    const mod = scopedRequire && scopedRequire('timers');
    if (mod && typeof mod.setTimeout === 'function' && typeof mod.setInterval === 'function') {
      nodeTimers = mod;
    }
  } catch {
    // Web build, or a future Blockbench that drops 'timers' from its free
    // module list — fall back to native timers and stay throttled.
  }
  return nodeTimers;
}

/** Node timer handles by synthetic id. Ids are negative so they can never
 *  collide with a real browser timer id that we pass through. */
const handles = new Map<number, { handle: any; kind: Kind }>();
let nextId = -1;

function schedule(kind: Kind, fn: any, delay: any, args: any[]): any {
  const timers = getNodeTimers();
  if (!timers || !document.hidden || typeof fn !== 'function') {
    return kind === 'timeout' ? native.setTimeout(fn, delay, ...args) : native.setInterval(fn, delay, ...args);
  }
  const id = nextId--;
  const ms = Math.max(0, Number(delay) || 0);
  const run = () => {
    if (kind === 'timeout') handles.delete(id);
    try {
      fn(...args);
    } catch (err) {
      // A throw here would surface on Node's side instead of the page's, so
      // report it ourselves rather than letting it escape into the host.
      console.error('[MCP] error in timer callback:', err);
    }
  };
  handles.set(id, { handle: kind === 'timeout' ? timers.setTimeout(run, ms) : timers.setInterval(run, ms), kind });
  return id;
}

function cancel(id: any): void {
  const entry = typeof id === 'number' ? handles.get(id) : undefined;
  if (!entry) {
    // Browser timeout and interval ids share one space and either clear
    // function accepts either kind, so one call covers both.
    native.clearTimeout(id);
    return;
  }
  handles.delete(id);
  const timers = getNodeTimers();
  if (entry.kind === 'timeout') timers.clearTimeout(entry.handle);
  else timers.clearInterval(entry.handle);
}

const shims = {
  setTimeout: ((fn: any, delay?: any, ...args: any[]) => schedule('timeout', fn, delay, args)) as any,
  setInterval: ((fn: any, delay?: any, ...args: any[]) => schedule('interval', fn, delay, args)) as any,
  clearTimeout: cancel as any,
  clearInterval: cancel as any,
};

let installed = false;

/** Patch the page timers. Returns false when Node timers are unreachable, in
 *  which case nothing is changed and hidden-window work stays throttled. */
export function installUnthrottledTimers(): boolean {
  if (installed) return true;
  if (!getNodeTimers()) return false;
  window.setTimeout = shims.setTimeout;
  window.setInterval = shims.setInterval;
  window.clearTimeout = shims.clearTimeout;
  window.clearInterval = shims.clearInterval;
  // Read by scripts/verify-hidden-window-timers.mjs to compare both paths.
  (window as any).__mcp_native_setTimeout = native.setTimeout;
  (window as any).__mcp_timer_backend = 'node-timers';
  installed = true;
  return true;
}

export function uninstallUnthrottledTimers(): void {
  if (!installed) return;
  // Only restore what is still ours — another plugin may have patched on top.
  if (window.setTimeout === shims.setTimeout) window.setTimeout = native.setTimeout as any;
  if (window.setInterval === shims.setInterval) window.setInterval = native.setInterval as any;
  if (window.clearTimeout === shims.clearTimeout) window.clearTimeout = native.clearTimeout as any;
  if (window.clearInterval === shims.clearInterval) window.clearInterval = native.clearInterval as any;
  const timers = getNodeTimers();
  if (timers) {
    handles.forEach(({ handle, kind }) => {
      if (kind === 'timeout') timers.clearTimeout(handle);
      else timers.clearInterval(handle);
    });
  }
  handles.clear();
  delete (window as any).__mcp_native_setTimeout;
  delete (window as any).__mcp_timer_backend;
  installed = false;
}

/** True when timers are currently immune to Chromium's background throttling. */
export function unthrottledTimersActive(): boolean {
  return installed;
}

export function timerStatus() {
  return {
    unthrottled: installed,
    backend: installed ? 'node-timers' : 'native (throttled while the window is hidden)',
    window_hidden: document.hidden,
    pending: handles.size,
  };
}
