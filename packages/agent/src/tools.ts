/**
 * @hmh/agent - base tools
 * The general coding-agent toolset: read, write, list, a guarded shell
 * runner, long-term memory, and image viewing (vision model). Deny-first
 * guard on obviously destructive one-liners; approvals live in the kernel.
 */
import { exec } from 'node:child_process';
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chatVision, homeDir, loadConfig, resolveProvider, type ProviderConfig, type Tool } from '@hmh/kernel';

const execCb = promisify(exec);

const DENY_PATTERNS: Array<{ re: RegExp; why: string }> = [
  // recursive deletes aimed at ROOT/HOME/SYSTEM targets only - relative
  // subdirectories are legitimate work (the approval gate still covers them;
  // a blanket ban made the agent unable to clean its own scratch dirs)
  { re: /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+["']?[/~"']|rm\s+-rf?\s+[CcJj]:\\?\/?(\s|$)/i, why: 'recursive delete of a root/home path' },
  { re: /(?:rd|rmdir)\s+\/s[^|;&]{0,24}["']?(?:[a-z]:\\(?:\s|["']|$)|[a-z]:\\(?:windows|program files(?: \(x86\))?|users|programdata)(?:\\|\s|["']|$)|\/(?:\s|["']|$)|~|%userprofile%|%homedrive%)/i, why: 'recursive delete of a root/system/home path' },
  { re: /remove-item\s+[^|;&]{0,40}-(?:recurse|force)[^|;&]{0,8}-(?:force|recurse)[^|;&]{0,12}["']?(?:[a-z]:\\(?:\s|["']|$)|[a-z]:\\(?:windows|program files(?: \(x86\))?|users|programdata)(?:\\|\s|["']|$)|~|%userprofile%|%homedrive%)/i, why: 'recursive delete of a system/home path' },
  { re: /format\s+[a-z]:/i, why: 'drive format' },
  { re: /shutdown|restart\s+computer|taskkill\s+\/f\s+\/im\s+explorer/i, why: 'system power/shell action' },
  { re: /reg\s+(delete|add).*(Run|CurrentVersion)/i, why: 'autostart registry mutation' },
  { re: /curl[^|;&]{0,80}\|\s*(ba)?sh|iwr[^|;&]{0,80}\|\s*iex|set-executionpolicy\s+unrestricted/i, why: 'remote-script-to-shell pipe / unrestricted execution policy' },
];

function safePath(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a text file. Returns the full content (truncated at 60k chars).',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'file path (absolute or relative to cwd)' } },
    required: ['path'],
  },
  async execute(args, ctx) {
    try {
      const text = await readFile(safePath(String(args.path), ctx.cwd), 'utf8');
      return { output: text.length > 60_000 ? text.slice(0, 60_000) + '\n...[truncated]' : text };
    } catch (err) {
      return { output: String(err), isError: true };
    }
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write a text file (creates or overwrites). Use for code, config, docs.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'file path' },
      content: { type: 'string', description: 'full file content' },
    },
    required: ['path', 'content'],
  },
  needsApproval: () => true,
  async execute(args, ctx) {
    try {
      const p = safePath(String(args.path), ctx.cwd);
      // the agent overwriting its own live config is high-blast-radius:
      // snapshot first so a bad rewrite is one copy away from recovery
      let backupNote = '';
      if (p === join(ctx.home, 'config.json')) {
        const bak = p + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
        await copyFile(p, bak).then(() => { backupNote = ` (backup: ${bak})`; }).catch(() => { /* first write */ });
      }
      await writeFile(p, String(args.content ?? ''), 'utf8');
      return { output: `wrote ${String(args.content ?? '').length} chars to ${p}${backupNote}` };
    } catch (err) {
      return { output: String(err), isError: true };
    }
  },
};

export const listDirTool: Tool = {
  name: 'list_dir',
  description: 'List a directory: names with d/- prefix and size.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'directory path (default cwd)' } },
    required: [],
  },
  async execute(args, ctx) {
    try {
      const dir = args.path ? safePath(String(args.path), ctx.cwd) : ctx.cwd;
      const entries = await readdir(dir, { withFileTypes: true });
      const lines = entries.slice(0, 300).map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`);
      return { output: `${dir}\n${lines.join('\n') || '(empty)'}` };
    } catch (err) {
      return { output: String(err), isError: true };
    }
  },
};

/** Host-shell pipe preflight: on Windows cmd, Unix-isms fail with cryptic
 *  mojibake and the model retries for many turns. Only the FIRST word of
 *  each host segment (split on | || && ;) is checked - Unix words inside
 *  arguments (docker exec c ls /app) belong to the container and stay legal.
 *  (Pure, testable.) */
export function unixPipeOnWindows(command: string, platform: string = process.platform): string | null {
  if (platform !== 'win32') return null;
  const eq: Record<string, string> = {
    head: 'more (pager) or node -e', tail: 'powershell -NoProfile -Command "Get-Content -Tail N"',
    grep: 'findstr /i "pattern" file', awk: 'node -e', sed: 'node -e',
    wc: 'powershell -Command "(Get-Content f).Count"', cat: 'type file',
    ls: 'dir /b', less: 'more', which: 'where name',
  };
  for (const seg of command.split(/\|\||&&|[|;]/)) {
    const first = (/^[\s"']*([\w.-]+)/.exec(seg)?.[1] ?? '').toLowerCase();
    if (eq[first]) {
      return `Refused before running: '${first}' does not exist in cmd.exe (the host shell). Use: ${eq[first]} . Do NOT retry the same pipeline.`;
    }
  }
  return null;
}

/** Repeat-failure short-circuit: the same command that already failed twice
 *  is refused without executing - the model repeating it 10x burned ~700k
 *  prompt tokens in one audited session. (Module-level, session-scoped.) */
const failedCommands = new Map<string, number>();

export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    'Run a shell command (one line, cmd on Windows / sh elsewhere) with a timeout. Prefer focused commands; read output carefully before deciding next steps.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'the command line to run' },
      timeout_ms: { type: 'number', description: 'timeout in ms (default 60000, max 300000)' },
    },
    required: ['command'],
  },
  needsApproval: () => true,
  async execute(args, ctx) {
    const command = String(args.command ?? '');
    for (const d of DENY_PATTERNS) {
      if (d.re.test(command)) {
        return { output: `Refused: ${d.why}. Ask the user to run it manually if truly intended.`, isError: true };
      }
    }
    const unix = unixPipeOnWindows(command);
    if (unix) return { output: unix, isError: true };
    const fails = failedCommands.get(command) ?? 0;
    if (fails >= 2) {
      return { output: `Refused: this exact command already failed ${fails} times this session. Change strategy (different command, different tool, or ask the user) instead of repeating it.`, isError: true };
    }
    const timeout = Math.min(Number(args.timeout_ms ?? 60_000), 300_000);
    try {
      const { stdout, stderr } = await execCb(command, {
        cwd: ctx.cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
      failedCommands.delete(command);
      return { output: (out.trim() || '(no output)').slice(0, 60_000) };
    } catch (err: unknown) {
      failedCommands.set(command, fails + 1);
      const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      const parts = [e.stdout, e.stderr, e.killed ? '(timed out)' : null, e.message].filter(Boolean).join('\n');
      return { output: parts.slice(0, 60_000), isError: true };
    }
  },
};

/** Zero-dependency web search: DuckDuckGo HTML endpoint, no API key. */
export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the web (DuckDuckGo, no key). Returns top results as: title | url | snippet. Use for current events, docs, versions - anything not knowable offline.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'search query' },
      count: { type: 'number', description: 'max results (default 6, max 10)' },
    },
    required: ['query'],
  },
  async execute(args) {
    const q = String(args.query ?? '').trim();
    if (!q) return { output: 'query required', isError: true };
    const n = Math.min(Math.max(Number(args.count ?? 6), 1), 10);
    try {
      const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { output: 'search: HTTP ' + res.status, isError: true };
      const html = await res.text();
      const out: string[] = [];
      const re = new RegExp('class="result__a"[^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)</a>[\\s\\S]*?class="result__snippet"[^>]*>([\\s\\S]*?)</a>', 'g');
      let m: RegExpExecArray | null;
      const strip = (t: string) => t.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      while ((m = re.exec(html)) && out.length < n) {
        let url = m[1];
        const uddg = /uddg=([^&]+)/.exec(url);
        if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { /* keep raw */ } }
        out.push((out.length + 1) + '. ' + strip(m[2]) + ' | ' + url + ' | ' + strip(m[3]).slice(0, 200));
      }
      return { output: out.length ? out.join('\n') : 'no results (try a different query)' };
    } catch (err) {
      return { output: 'search failed: ' + String(err).slice(0, 160), isError: true };
    }
  },
};

/** Fetch a URL and return readable text (tags stripped, entities decoded,
 *  size-bounded). Pairs with web_search: search finds, fetch reads. */
export const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a web page and return its readable text (HTML stripped, entities decoded, bounded to ~12k chars). Use after web_search to read a result, or for any docs page / raw file URL.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL' },
      maxChars: { type: 'number', description: 'bound (default 12000, max 40000)' },
    },
    required: ['url'],
  },
  async execute(args) {
    const url = String(args.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return { output: 'only http(s) URLs are supported', isError: true };
    const max = Math.min(Math.max(Number(args.maxChars ?? 12_000), 500), 40_000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'text/html,application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(20_000),
        redirect: 'follow',
      });
      if (!res.ok) return { output: 'fetch: HTTP ' + res.status, isError: true };
      const ct = String(res.headers.get('content-type') ?? '');
      const body = await res.text();
      if (ct.includes('json')) return { output: body.slice(0, max) };
      let text = body
        .replace(/[\s\S]*?<body[^>]*>/i, '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
      const ents: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ' };
      text = text.replace(/&(amp|lt|gt|quot|#x27|#39|nbsp);/g, (m) => ents[m] ?? m);
      text = text.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
      return { output: text.slice(0, max) + (text.length > max ? '\n...[truncated at ' + max + ' chars]' : '') };
    } catch (err) {
      return { output: 'fetch failed: ' + String(err).slice(0, 160), isError: true };
    }
  },
};

/** Desktop automation, step 1 (first-class): screenshot the primary display
 *  to a PNG and hand the path back - the agent then reads it with see_image
 *  (vision chain). Windows via PowerShell System.Drawing; other platforms
 *  report the gap honestly instead of failing silently. */
export const desktopScreenshotTool: Tool = {
  name: 'desktop_screenshot',
  description:
    'Screenshot the primary display to a PNG file and return its path. Immediately follow with see_image on that path to actually look at it. Use for: checking a GUI app state, reading dialogs/errors, verifying what a desktop automation step did.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  needsApproval: () => true,
  async execute(_args, ctx) {
    if (process.platform !== 'win32') {
      return { output: 'desktop_screenshot currently supports Windows only (PowerShell + System.Drawing)', isError: true };
    }
    const out = join(ctx.home, 'tmp', 'shot-' + Date.now() + '.png');
    await import('node:fs/promises').then((f) => f.mkdir(join(ctx.home, 'tmp'), { recursive: true }));
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$b = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height)',
      '$g = [System.Drawing.Graphics]::FromImage($b)',
      '$g.CopyFromScreen(0, 0, 0, 0, $b.Size)',
      "$b.Save('OUTPATH', [System.Drawing.Imaging.ImageFormat]::Png)",
      '$g.Dispose(); $b.Dispose()',
    ].join('; ').replace(/OUTPATH/g, out.replace(/\\/g, '\\\\').replace(/'/g, "''"));
    try {
      const { execFile } = await import('node:child_process');
      const { promisify: prom } = await import('node:util');
      await prom(execFile)('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 20_000, windowsHide: true });
      return { output: 'screenshot saved: ' + out + ' - now call see_image with this path' };
    } catch (err) {
      return { output: 'screenshot failed: ' + String(err).slice(0, 200), isError: true };
    }
  },
};

/** Desktop automation steps 2-3: click and type. PowerShell + Win32 for
 *  mouse (SetCursorPos + mouse_event), SendKeys for keyboard. Pair with
 *  desktop_screenshot + see_image: look → act → verify. */
export const desktopClickTool: Tool = {
  name: 'desktop_click',
  description:
    'Click the mouse at screen coordinates (left click). ALWAYS desktop_screenshot + see_image FIRST to find the right coordinates, then click, then screenshot again to verify. Coordinates are pixels from top-left of the primary display.',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'X pixel coordinate' },
      y: { type: 'number', description: 'Y pixel coordinate' },
    },
    required: ['x', 'y'],
  },
  needsApproval: () => true,
  async execute(args) {
    if (process.platform !== 'win32') return { output: 'desktop_click supports Windows only', isError: true };
    const x = Math.round(Number(args.x));
    const y = Math.round(Number(args.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { output: 'x/y must be numbers', isError: true };
    const ps = [
      // no here-strings (they break in -Command inline mode); use a single C# line
      "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);' -Name Win32M -Namespace W",
      '[W.Win32M]::SetCursorPos(XVAL, YVAL)',
      'Start-Sleep -Milliseconds 80',
      '[W.Win32M]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)',
      'Start-Sleep -Milliseconds 30',
      '[W.Win32M]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)',
    ].join('; ').replace(/XVAL/g, String(x)).replace(/YVAL/g, String(y));
    try {
      const { execFile } = await import('node:child_process');
      const { promisify: prom } = await import('node:util');
      const r = await prom(execFile)('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 10_000, windowsHide: true });
      return { output: 'clicked at ' + x + ',' + y + ' - now screenshot to verify' };
    } catch (err) {
      return { output: 'click failed: ' + String(err).slice(0, 200), isError: true };
    }
  },
};

export const desktopTypeTool: Tool = {
  name: 'desktop_type',
  description:
    'Type text (or a key combo like ENTER, TAB, ^a, {F5}) into the focused window. Use after desktop_click to focus a field. Standard SendKeys syntax.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'text to type, or SendKeys combo (ENTER, TAB, ESC, ^a, +{TAB}, {DOWN})' },
    },
    required: ['text'],
  },
  needsApproval: () => true,
  async execute(args) {
    if (process.platform !== 'win32') return { output: 'desktop_type supports Windows only', isError: true };
    const text = String(args.text ?? '');
    if (!text) return { output: 'text required', isError: true };
    const safe = text.replace(/'/g, "''").replace(/"/g, String.fromCharCode(34));
    const ps = [
      '$ws = New-Object -ComObject WScript.Shell',
      'Start-Sleep -Milliseconds 50',
      "$ws.SendKeys('TEXTVAL')",
      '"typed"',
    ].join('; ').replace(/TEXTVAL/g, safe);
    try {
      const { execFile } = await import('node:child_process');
      const { promisify: prom } = await import('node:util');
      await prom(execFile)('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 10_000, windowsHide: true });
      return { output: 'typed: ' + text.slice(0, 40) };
    } catch (err) {
      return { output: 'type failed: ' + String(err).slice(0, 200), isError: true };
    }
  },
};

/** Browser automation, first-class entry point: open a URL in the user's
 *  default browser (visible window), then drive it with the desktop triad:
 *  desktop_screenshot + see_image to LOOK, desktop_click/desktop_type to
 *  ACT, desktop_screenshot again to VERIFY. This sees-plan-act loop works
 *  with any browser and any page (full JS rendering, login states, CAPTCHAs
 *  - everything a real user sees). Headless alternatives (--dump-dom etc)
 *  are unreliable on Windows; the visible browser is the honest primitive.
 */
export const browserOpenTool: Tool = {
  name: 'browser_open',
  description:
    'Open a URL in the user\'s default browser (visible). Then use desktop_screenshot + see_image to see the page, desktop_click/desktop_type to interact. Full workflow: browser_open → desktop_screenshot → see_image (find elements) → desktop_click (click) → desktop_screenshot (verify).',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL to open' },
    },
    required: ['url'],
  },
  needsApproval: () => true,
  async execute(args) {
    const url = String(args.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return { output: 'only http(s) URLs', isError: true };
    try {
      if (process.platform === 'win32') {
        const { execFile } = await import('node:child_process');
        const { promisify: prom } = await import('node:util');
        await prom(execFile)('cmd.exe', ['/c', 'start', '', url], { timeout: 8000, windowsHide: true });
      } else if (process.platform === 'darwin') {
        const { execFile } = await import('node:child_process');
        const { promisify: prom } = await import('node:util');
        await prom(execFile)('open', [url], { timeout: 8000 });
      } else {
        const { execFile } = await import('node:child_process');
        const { promisify: prom } = await import('node:util');
        await prom(execFile)('xdg-open', [url], { timeout: 8000 });
      }
      return { output: 'opened ' + url + ' in the default browser. Wait ~2s for load, then desktop_screenshot + see_image to see the page.' };
    } catch (err) {
      return { output: 'open failed: ' + String(err).slice(0, 160), isError: true };
    }
  },
};

/** Remote command execution over SSH (zero-dep: OpenSSH binary).
 *  Hosts come from config sshHosts (name/host/user/port/keyPath); secrets
 *  never leave HMH_HOME. Read-only commands skip the approval card,
 *  everything else is gated. */
export interface SshHost {
  name: string;
  host: string;
  user: string;
  port?: number;
  /** private-key path; defaults to the agent's own key resolution (~/.ssh) */
  keyPath?: string;
}

export const sshRunTool: Tool = {
  name: 'ssh_run',
  description:
    'Run a command on a remote host over SSH. Hosts must be configured under sshHosts in config.json (name/host/user/port/keyPath). Read-only probes (ls/cat/ps/grep/free/df/uptime/systemctl status) run without the approval card; anything else is approval-gated. Use for server ops, remote checks, deployments.',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: 'host name from config sshHosts' },
      command: { type: 'string', description: 'shell command to run remotely' },
      timeout_ms: { type: 'number', description: 'timeout in ms (default 20000, max 120000)' },
    },
    required: ['host', 'command'],
  },
  needsApproval(args) {
    const cmd = String(args.command ?? '');
    // read-only probe allowlist - no destructive verbs, no pipes into writes
    const probe = /^(ls|cat|head|tail|df|du|free|uptime|whoami|hostname|uname|systemctl (status|list-units)|ps|grep|find|wc|date|echo|id|ip |ifconfig|nmap --version)/.test(cmd);
    const writes = /rm|mv|dd|mkfs|reboot|shutdown|kill|pkill|systemctl (start|stop|restart|enable|disable)|apt|yum|docker (rm|rmi|prune)|truncate|>||/i;
    return !(probe && !writes);
  },
  async execute(args) {
    const cfg = await loadConfig();
    const hosts = (cfg as { sshHosts?: Record<string, SshHost> }).sshHosts ?? {};
    const h = hosts[String(args.host ?? '')];
    if (!h) return { output: 'unknown host. configured: ' + (Object.keys(hosts).join(', ') || '(none)'), isError: true };
    const command = String(args.command ?? '');
    if (!command.trim()) return { output: 'command required', isError: true };
    const timeout = Math.min(Number(args.timeout_ms ?? 20_000), 120_000);
    const sshArgs = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new',
      ...(h.keyPath ? ['-i', h.keyPath] : []),
      '-p', String(h.port ?? 22),
      (h.user ? h.user + '@' : '') + h.host,
      command,
    ];
    try {
      const { execFile } = await import('node:child_process');
      const { promisify: prom } = await import('node:util');
      const r = await prom(execFile)('ssh', sshArgs, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      const out = ((r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')).trim();
      return { output: (out || '(no output)').slice(0, 30_000) };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      const parts = [e.stdout, e.stderr, e.killed ? '(timed out)' : e.message];
      return { output: parts.filter(Boolean).join('\n').slice(0, 400), isError: true };
    }
  },
};

export const rememberTool: Tool = {
  name: 'remember',
  description:
    'Persist a note to long-term memory (survives restarts, loaded into future sessions). Use for user preferences, project facts, and hard-won lessons - not transient details.',
  parameters: {
    type: 'object',
    properties: { note: { type: 'string', description: 'the fact/lesson to remember, one line preferred' } },
    required: ['note'],
  },
  async execute(args) {
    try {
      const { appendMemory } = await import('@hmh/evolution');
      await appendMemory(homeDir(), String(args.note ?? ''));
      return { output: 'remembered.' };
    } catch (err) {
      return { output: String(err), isError: true };
    }
  },
};

export const seeImageTool: Tool = {
  name: 'see_image',
  description:
    'Look at an image file (png/jpg/webp) with the configured vision model and answer a question about it, or describe it. Use for UI screenshots, rendered pages, photos of device screens - anything visual. Requires a vision provider in config.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'image file path (absolute or relative to cwd)' },
      question: { type: 'string', description: 'what to answer about the image (default: describe it)' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const cfg = await loadConfig();
    const hasVision = Boolean(cfg.vision || (cfg.routing?.vision && cfg.providers?.[cfg.routing.vision]));
    if (!hasVision) {
      return {
        output: 'No vision provider configured. Add a "vision" block or providers+routing.vision to HMH_HOME/config.json.',
        isError: true,
      };
    }
    const p = safePath(String(args.path ?? ''), ctx.cwd);
    let data: Buffer;
    try {
      data = await readFile(p);
    } catch (err) {
      return { output: String(err), isError: true };
    }
    if (data.length > 6 * 1024 * 1024) {
      return { output: `Image too large (${(data.length / 1024 / 1024).toFixed(1)} MB, max 6 MB).`, isError: true };
    }
    const mime = /\.(jpg|jpeg)$/i.test(p) ? 'image/jpeg' : /\.webp$/i.test(p) ? 'image/webp' : 'image/png';
    const url = `data:${mime};base64,${data.toString('base64')}`;
    const question = String(args.question ?? 'Describe this image precisely and concisely.');
    const chain: ProviderConfig[] = [resolveProvider(cfg, 'vision'), ...(cfg.visionFallbacks ?? [])].filter((x) => x.baseUrl);
    const errors: string[] = [];
    for (const provider of chain) {
      try {
        const answer = await chatVision(provider, question, url);
        return { output: `[${p}]\n${answer}` };
      } catch (err) {
        errors.push(`${(provider as { model?: string }).model ?? '?'}: ${String(err).slice(0, 120)}`);
      }
    }
    return { output: `all vision providers failed:\n${errors.join('\n')}`, isError: true };
  },
};

export const baseTools: Tool[] = [readFileTool, writeFileTool, listDirTool, runCommandTool, rememberTool, seeImageTool];
