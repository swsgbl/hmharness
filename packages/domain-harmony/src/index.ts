/**
 * @hmh/domain-harmony
 * HarmonyOS domain tools. Device + toolchain probes are zero-risk;
 * build/install/launch/logs cover the code-to-device lifecycle and landed
 * in Phase 1. Device-mutating tools (install/launch/uninstall) carry
 * needsApproval - the kernel loop gates them behind user confirmation.
 */
import { execFile } from 'node:child_process';
import { accessSync } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '@hmh/kernel';
import { harmonyProjectCreate } from './project.ts';
import { harmonyCjpmBuild, harmonyCjpmTest, findCjpm } from './cangjie.ts';
import { harmonyLint } from './lint.ts';
import { emulatorTools } from './emulator.ts';

const exec = promisify(execFile);

function devecoHome(): string {
  return process.env.HM_DEVECO_HOME ?? 'C:\\DevEco-Studio';
}

async function run(
  cmd: string,
  args: string[],
  timeoutMs = 20_000,
  cwd?: string,
  extraEnv?: Record<string, string>,
): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      cwd,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    return { ok: true, out: (stdout || stderr || '(no output)').trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').slice(0, 4000) };
  }
}

async function findHdc(): Promise<string> {
  // PATH first, then the DevEco SDK layout
  const p = await run('hdc', ['--version'], 8000);
  if (p.ok) return 'hdc';
  const candidate = join(devecoHome(), 'sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe');
  try {
    await access(candidate);
    return candidate;
  } catch {
    return '';
  }
}

/** hdc command prefix honoring an optional target, e.g. ["-t", "127.0.0.1:5555"]. */
function hdcArgs(target?: string): string[] {
  const t = target?.trim();
  return t ? ['-t', t] : [];
}

/* ------------------------------------------------------------------ */
/* Zero-risk probes (Phase 0)                                          */
/* ------------------------------------------------------------------ */

export const harmonyDevices: Tool = {
  name: 'harmony_devices',
  description:
    'List connected HarmonyOS devices/emulators (targets) via hdc. Returns the raw target list: index, state and connect string. Use before any device operation to learn the target id.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    const hdc = await findHdc();
    if (!hdc) {
      return {
        output: 'hdc not found. Install DevEco Studio (SDK component) or add its toolchains dir to PATH, or set HM_DEVECO_HOME.',
        isError: true,
      };
    }
    const r = await run(hdc, ['list', 'targets']);
    const lines = r.out.split('\n').map((l) => l.trim()).filter((l) => l && l !== '[Empty]');
    if (lines.length === 0) return { output: 'No devices connected. Start an emulator or plug in a device with USB debugging.' };
    return { output: lines.map((l, i) => `${i}: ${l}`).join('\n') };
  },
};

export const harmonyToolchainCheck: Tool = {
  name: 'harmony_toolchain_check',
  description:
    'Check the local HarmonyOS development toolchain: hdc (devices), hvigorw (build) and ohpm (packages), with resolved paths and versions where available.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    const lines: string[] = [];
    const hdc = await findHdc();
    if (hdc) {
      const v = await run(hdc, ['--version'], 8000);
      lines.push(`hdc: OK (${hdc}) ${v.out.split('\n')[0] ?? ''}`.trim());
    } else lines.push('hdc: MISSING');

    const hvigorw = join(devecoHome(), 'tools', 'hvigor', 'bin', hvigorwName());
    try {
      await access(hvigorw);
      lines.push(`hvigorw: OK (${hvigorw})`);
    } catch {
      lines.push(`hvigorw: MISSING (looked at ${hvigorw})`);
    }

    const ohpm = join(devecoHome(), 'tools', 'ohpm', 'bin', ohpmName());
    try {
      await access(ohpm);
      lines.push(`ohpm: OK (${ohpm})`);
    } catch {
      lines.push(`ohpm: MISSING (looked at ${ohpm})`);
    }

    const cjpm = await findCjpm();
    if (cjpm) {
      const v = await run(cjpm, ['--version'], 8000);
      lines.push(`cjpm: OK (${cjpm}) ${v.out.split('\n')[0] ?? ''}`.trim());
    } else {
      lines.push('cjpm: MISSING (set HM_CJPM or add cangjie bin to PATH)');
    }
    return { output: lines.join('\n') };
  },
};

/* ------------------------------------------------------------------ */
/* Build / install / launch / logs (Phase 1)                           */
/* ------------------------------------------------------------------ */

function hvigorwName(): string {
  return process.platform === 'win32' ? 'hvigorw.bat' : 'hvigorw.sh';
}
function ohpmName(): string {
  return process.platform === 'win32' ? 'ohpm.bat' : 'ohpm';
}
/** Windows .bat scripts must go through cmd; posix scripts run directly. */
async function runScript(scriptPath: string, args: string[], timeoutMs: number, cwd: string, extraEnv?: Record<string, string>) {
  if (process.platform === 'win32') {
    return run('cmd', ['/c', scriptPath, ...args], timeoutMs, cwd, buildEnv(extraEnv));
  }
  return run('sh', [scriptPath, ...args], timeoutMs, cwd, buildEnv(extraEnv));
}

/** hvigor/ohpm ship with a bundled node - make sure they can find it. */
function buildEnv(extra?: Record<string, string>): Record<string, string> | undefined {
  const env: Record<string, string> = { ...extra };
  const nodeDir = join(devecoHome(), 'tools', 'node');
  try {
    accessSyncOrIgnore(nodeDir);
    if (!process.env.NODE_HOME) env.NODE_HOME = nodeDir;
    if (!process.env.NODE_PATH) env.NODE_PATH = join(nodeDir, 'node_modules', 'npm');
  } catch {
    /* DevEco node layout differs - fall back to inherited env */
  }
  // Standalone hvigorw runs need the SDK root; DevEco sets this globally,
  // shells without it get "Invalid value of DEVECO_SDK_HOME".
  if (!process.env.DEVECO_SDK_HOME) {
    const sdkRoot = join(devecoHome(), 'sdk');
    try {
      accessSyncOrIgnore(sdkRoot);
      env.DEVECO_SDK_HOME = sdkRoot;
    } catch {
      /* no sdk dir - let hvigor report it */
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function accessSyncOrIgnore(p: string): void {
  accessSync(p);
}

/** Walk up from `start` looking for the hvigor project marker. */
async function findProjectRoot(start: string): Promise<string> {
  let dir = resolve(start);
  for (;;) {
    if (await exists(join(dir, 'build-profile.json5'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** JSON5-lite parse: tolerant of line/block comments and trailing commas. */
function parseJson5(text: string): Record<string, unknown> {
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(cleaned) as Record<string, unknown>;
}

async function readJson5(p: string): Promise<Record<string, unknown> | null> {
  try {
    return parseJson5(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function bundleNameOf(projectRoot: string): Promise<string> {
  const app = await readJson5(join(projectRoot, 'AppScope', 'app.json5'));
  const b = (app as { app?: { bundleName?: string } } | null)?.app?.bundleName;
  if (b) return b;
  // entry/src/main/module.json5 fallback (module name - a weak substitute,
  // real bundleName lives in AppScope)
  const mod = await readJson5(join(projectRoot, 'entry', 'src', 'main', 'module.json5'));
  return (mod as unknown as { module?: { name?: string } } | null)?.module?.name ?? '';
}

/** Newest .hap under the project's build outputs (module dirs: entry/build/...). */
async function newestHap(projectRoot: string): Promise<string> {
  let best = '';
  let bestMtime = 0;
  const stack = [projectRoot];
  for (let depth = 0; stack.length > 0 && depth < 1000; depth++) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'oh_modules', '.hvigor', '.preview', 'src'].includes(e.name)) continue;
        stack.push(p);
      } else if (e.name.endsWith('.hap')) {
        const m = (await stat(p)).mtimeMs;
        if (m > bestMtime) {
          bestMtime = m;
          best = p;
        }
      }
    }
  }
  return best;
}

export const harmonyBuild: Tool = {
  name: 'harmony_build',
  description:
    'Build a HarmonyOS project with hvigor (assembleHap). Accepts an optional project path (defaults to walking up from cwd for build-profile.json5). Long-running: allow several minutes. Reports the build result tail and the produced .hap path.',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'project directory containing build-profile.json5 (default: auto-detect from cwd)' },
      clean: { type: 'boolean', description: 'run a clean build (slower)' },
    },
    required: [],
  },
  async execute(args, ctx) {
    const hvigorw = join(devecoHome(), 'tools', 'hvigor', 'bin', hvigorwName());
    if (!(await exists(hvigorw))) {
      return { output: `hvigorw not found at ${hvigorw}. Set HM_DEVECO_HOME or install DevEco Studio.`, isError: true };
    }
    const start = typeof args.project === 'string' && args.project ? resolve(ctx.cwd, args.project) : ctx.cwd;
    const root = await findProjectRoot(start);
    if (!root) {
      return { output: `No HarmonyOS project found at or above ${start} (looking for build-profile.json5).`, isError: true };
    }
    if (args.clean === true) await runScript(hvigorw, ['clean'], 300_000, root);
    const r = await runScript(hvigorw, ['--mode', 'module', '-p', 'product=default', 'assembleHap', '--no-daemon'], 900_000, root);
    const hap = await newestHap(root);
    const tail = r.out.length > 4000 ? '...\n' + r.out.slice(-4000) : r.out;
    const okLine = r.ok && /BUILD SUCCESSFUL/i.test(r.out);
    const summary = [
      `project: ${root}`,
      `result: ${okLine ? 'BUILD SUCCESSFUL' : r.ok ? 'finished (check log)' : 'FAILED'}`,
      hap ? `hap: ${hap}` : 'hap: none found under build/',
      '',
      tail,
    ].join('\n');
    return { output: summary, isError: !okLine };
  },
};

export const harmonyInstall: Tool = {
  name: 'harmony_install',
  description:
    'Install a .hap onto a connected HarmonyOS device via hdc (mutates the device - requires approval). Without a path, installs the newest .hap in the current project build output. Tries "hdc install" then falls back to "hdc app install".',
  parameters: {
    type: 'object',
    properties: {
      hap: { type: 'string', description: 'path to the .hap file (default: newest under the project build output)' },
      target: { type: 'string', description: 'device target id from harmony_devices (default: the only/first device)' },
      replace: { type: 'boolean', description: 'replace an existing installation (default true)' },
    },
    required: [],
  },
  needsApproval: () => true,
  async execute(args, ctx) {
    const hdc = await findHdc();
    if (!hdc) return { output: 'hdc not found.', isError: true };
    let hap = typeof args.hap === 'string' && args.hap ? resolve(ctx.cwd, args.hap) : '';
    if (!hap) {
      const root = await findProjectRoot(ctx.cwd);
      if (!root) return { output: 'No .hap path given and no project found around cwd.', isError: true };
      hap = await newestHap(root);
      if (!hap) return { output: `No .hap found under ${join(root, 'build')}. Build first with harmony_build.`, isError: true };
    }
    if (!(await exists(hap))) return { output: `No such file: ${hap}`, isError: true };
    const pre = hdcArgs(typeof args.target === 'string' ? args.target : undefined);
    const replace = args.replace !== false;
    let r = await run(hdc, [...pre, 'install', ...(replace ? ['-r'] : []), hap], 120_000);
    if (!r.ok || /unknown command|invalid/i.test(r.out)) {
      r = await run(hdc, [...pre, 'app', 'install', ...(replace ? ['-r'] : []), hap], 120_000);
    }
    return { output: `install ${hap}\n${r.out}`, isError: !r.ok };
  },
};

export const harmonyLaunch: Tool = {
  name: 'harmony_launch',
  description:
    'Launch an app on a connected HarmonyOS device via "hdc shell aa start" (mutates device state - requires approval). bundle defaults to the current project AppScope/app.json5 bundleName; ability defaults to EntryAbility.',
  parameters: {
    type: 'object',
    properties: {
      bundle: { type: 'string', description: 'bundle name, e.g. com.example.myapp (default: from the project)' },
      ability: { type: 'string', description: 'ability name (default: EntryAbility)' },
      target: { type: 'string', description: 'device target id from harmony_devices' },
    },
    required: [],
  },
  needsApproval: () => true,
  async execute(args, ctx) {
    const hdc = await findHdc();
    if (!hdc) return { output: 'hdc not found.', isError: true };
    let bundle = typeof args.bundle === 'string' && args.bundle ? args.bundle : '';
    if (!bundle) {
      const root = await findProjectRoot(ctx.cwd);
      if (!root) return { output: 'No bundle given and no project found around cwd to read AppScope/app.json5.', isError: true };
      bundle = await bundleNameOf(root);
      if (!bundle) return { output: `Could not read bundleName from the project at ${root}.`, isError: true };
    }
    const ability = typeof args.ability === 'string' && args.ability ? args.ability : 'EntryAbility';
    const pre = hdcArgs(typeof args.target === 'string' ? args.target : undefined);
    const r = await run(hdc, [...pre, 'shell', 'aa', 'start', '-a', ability, '-b', bundle], 30_000);
    return { output: `aa start -a ${ability} -b ${bundle}\n${r.out}`, isError: !r.ok };
  },
};

export const harmonyLogs: Tool = {
  name: 'harmony_logs',
  description:
    'Fetch recent device logs via "hdc shell hilog -x" (dump-and-exit). Returns the last N lines, optionally filtered by a substring. Use for diagnosing crashes, ability failures, or app behavior after harmony_launch.',
  parameters: {
    type: 'object',
    properties: {
      lines: { type: 'number', description: 'how many trailing lines to return (default 200, max 2000)' },
      grep: { type: 'string', description: 'only include lines containing this substring' },
      target: { type: 'string', description: 'device target id from harmony_devices' },
    },
    required: [],
  },
  async execute(args) {
    const hdc = await findHdc();
    if (!hdc) return { output: 'hdc not found.', isError: true };
    const lines = Math.min(Math.max(Number(args.lines ?? 200), 1), 2000);
    const pre = hdcArgs(typeof args.target === 'string' ? args.target : undefined);
    const r = await run(hdc, [...pre, 'shell', 'hilog', '-x'], 60_000);
    if (!r.ok) return { output: r.out, isError: true };
    let all = r.out.split('\n');
    if (typeof args.grep === 'string' && args.grep) all = all.filter((l) => l.includes(args.grep as string));
    return { output: all.slice(-lines).join('\n') || '(no matching log lines)' };
  },
};

export const harmonyUninstall: Tool = {
  name: 'harmony_uninstall',
  description: 'Uninstall a bundle from a connected device via hdc (destructive - requires approval).',
  parameters: {
    type: 'object',
    properties: {
      bundle: { type: 'string', description: 'bundle name, e.g. com.example.myapp' },
      target: { type: 'string', description: 'device target id from harmony_devices' },
    },
    required: ['bundle'],
  },
  needsApproval: () => true,
  async execute(args) {
    const hdc = await findHdc();
    if (!hdc) return { output: 'hdc not found.', isError: true };
    const pre = hdcArgs(typeof args.target === 'string' ? args.target : undefined);
    let r = await run(hdc, [...pre, 'uninstall', String(args.bundle)], 60_000);
    if (!r.ok || /unknown command|invalid/i.test(r.out)) {
      r = await run(hdc, [...pre, 'app', 'uninstall', String(args.bundle)], 60_000);
    }
    return { output: r.out, isError: !r.ok };
  },
};

export const harmonyTools: Tool[] = [
  harmonyDevices,
  harmonyToolchainCheck,
  harmonyBuild,
  harmonyInstall,
  harmonyLaunch,
  harmonyLogs,
  harmonyUninstall,
  harmonyProjectCreate,
  harmonyCjpmBuild,
  harmonyCjpmTest,
  harmonyLint,
  ...emulatorTools,
];

export { harmonyProjectCreate, scaffoldProject, solidPng, sdkVersion } from './project.ts';
export { harmonyCjpmBuild, harmonyCjpmTest, findCjpm } from './cangjie.ts';
