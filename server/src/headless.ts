// Headless mode (BB_HEADLESS=1): when a tool call finds no Blockbench, start it and keep
// its window hidden. Blockbench gives plugins no window API (require('electron') is not
// allowed), so the window is hidden from outside, through the OS.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

export const headlessEnabled = /^(1|true|yes|on)$/i.test(process.env.BB_HEADLESS ?? '');

const LAUNCH_TIMEOUT_MS = Number(process.env.BB_LAUNCH_TIMEOUT_MS || 90_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function blockbenchExecutable(): string {
  if (process.env.BB_EXECUTABLE) return process.env.BB_EXECUTABLE;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Blockbench', 'Blockbench.exe');
  if (process.platform === 'darwin') return '/Applications/Blockbench.app/Contents/MacOS/Blockbench';
  return 'blockbench';
}

function run(file: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 20_000 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout) });
    });
  });
}

async function isBlockbenchRunning(): Promise<boolean> {
  if (process.platform === 'win32') {
    const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq Blockbench.exe', '/NH']);
    return /Blockbench\.exe/i.test(stdout);
  }
  return (await run('pgrep', ['-x', '-i', 'blockbench'])).code === 0;
}

// Top-level, titled Chromium windows of the Blockbench processes = the app windows
// (Electron also owns untitled helper windows that must stay hidden). ShowWindowAsync, not
// ShowWindow: a process started with windowsHide has its FIRST ShowWindow call forced to SW_HIDE.
const WIN32_HELPER = `
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class BBWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static List<IntPtr> Find(uint[] pids) {
    var set = new HashSet<uint>(pids);
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (set.Contains(pid) && GetWindow(h, 4) == IntPtr.Zero && GetWindowTextLength(h) > 0) {
        var cls = new StringBuilder(64);
        GetClassName(h, cls, 64);
        if (cls.ToString() == "Chrome_WidgetWin_1") list.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  // Hide each Blockbench app window the moment it is shown (until this process is killed).
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr h, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint msg; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
  static WinEventProc onShow; // a field, so the GC cannot collect the callback
  public static void KeepHidden() {
    onShow = (hook, ev, h, idObject, idChild, thread, time) => {
      if (idObject != 0 || GetWindow(h, 4) != IntPtr.Zero) return;
      var cls = new StringBuilder(64);
      GetClassName(h, cls, 64);
      if (cls.ToString() != "Chrome_WidgetWin_1") return;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      try { if (System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.Equals("Blockbench", StringComparison.OrdinalIgnoreCase)) ShowWindowAsync(h, 0); } catch {}
    };
    SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, onShow, 0, 0, 0); // EVENT_OBJECT_SHOW, out of context
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {}
  }
}
'@
function Wins { [BBWin]::Find([uint32[]]@(Get-Process -Name Blockbench -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })) }
switch ($mode) {
  'status' { $w = @(Wins); if (!$w.Count) { 'none' } elseif (@($w | Where-Object { [BBWin]::IsWindowVisible($_) }).Count) { 'visible' } else { 'hidden' } }
  'hide' { $w = @(Wins); foreach ($h in $w) { [void][BBWin]::ShowWindowAsync($h, 0) }; if ($w.Count) { 'hidden' } else { 'none' } }
  'show' { $w = @(Wins); foreach ($h in $w) { [void][BBWin]::ShowWindowAsync($h, 5); [void][BBWin]::SetForegroundWindow($h) }; if ($w.Count) { 'visible' } else { 'none' } }
  'keep-hidden' { [BBWin]::KeepHidden() }
}
`;

function powershellArgs(mode: string): string[] {
  const script = `$mode = '${mode}'\n${WIN32_HELPER}`;
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function requireWindows() {
  // shortcut: window control is Windows-only; macOS (osascript) / Linux (xdotool, or xvfb-run via BB_EXECUTABLE) when someone needs it.
  if (process.platform !== 'win32') throw new Error(`Showing/hiding the Blockbench window is only supported on Windows (this is ${process.platform}). On Linux, run Blockbench under xvfb-run by pointing BB_EXECUTABLE at a wrapper script.`);
}

/** "none" = no Blockbench window exists. */
export async function windowCommand(action: 'status' | 'show' | 'hide'): Promise<'visible' | 'hidden' | 'none'> {
  requireWindows();
  const { code, stdout } = await run('powershell.exe', powershellArgs(action));
  const state = stdout.trim().split(/\s+/).pop();
  if (code !== 0 || !['visible', 'hidden', 'none'].includes(state ?? '')) throw new Error(`Window ${action} failed (exit ${code}): ${stdout.trim().slice(0, 300)}`);
  return state as 'visible' | 'hidden' | 'none';
}

let starting: Promise<void> | null = null;

/**
 * Start Blockbench hidden unless it is already running, then wait until `probe`
 * (a round-trip to the plugin) succeeds. Concurrent callers share one launch.
 */
export function ensureBlockbench(probe: () => Promise<unknown>): Promise<void> {
  starting ??= start(probe).finally(() => { starting = null; });
  return starting;
}

async function start(probe: () => Promise<unknown>): Promise<void> {
  const running = await isBlockbenchRunning();
  let keeper: ChildProcess | null = null;
  if (!running) {
    const exe = blockbenchExecutable();
    if (isAbsolute(exe) && !existsSync(exe)) {
      throw new Error(`Headless mode could not find Blockbench at ${exe}. Install it or set BB_EXECUTABLE to its executable.`);
    }
    if (process.platform === 'win32') {
      const k = spawn('powershell.exe', powershellArgs('keep-hidden'), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      keeper = k;
      // Launch only once the show-hook is installed (compiling it takes a second or two).
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 8000);
        k.stdout!.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(timer); resolve(); } });
        k.on('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    console.error(`[headless] starting Blockbench: ${exe}`);
    const app = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true });
    app.on('error', (err) => console.error(`[headless] could not start Blockbench: ${err.message}`));
    app.unref();
  }
  try {
    const deadline = Date.now() + (running ? 10_000 : LAUNCH_TIMEOUT_MS);
    for (;;) {
      try {
        await probe();
        break;
      } catch {
        if (Date.now() > deadline) {
          throw new Error(running
            ? 'Blockbench is running but the "Blockbench MCP Bridge" plugin did not connect within 10 s. Check that the plugin is installed and enabled (File > Plugins).'
            : `Blockbench was started but the "Blockbench MCP Bridge" plugin did not connect within ${Math.round(LAUNCH_TIMEOUT_MS / 1000)} s. Check that the plugin is installed and enabled (File > Plugins).`);
        }
        await sleep(500);
      }
    }
    // Electron shows the window once the page has loaded, which can trail the plugin's connect.
    if (keeper) await sleep(3000);
  } finally {
    keeper?.kill();
  }
}
