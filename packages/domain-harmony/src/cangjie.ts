/**
 * @hmh/domain-harmony - cangjie (cjpm) tools
 * Cangjie package-manager build/test for HarmonyOS native modules.
 * Resolution: HM_CJPM env override > PATH > known DevEco-adjacent install
 * roots. CANGJIE_HOME is derived from the cjpm.exe layout and injected -
 * the #1 Windows pitfall recorded in the cjpm-build-repair skill.
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '@hmh/kernel';

const exec = promisify(execFile);

const CJPM_CANDIDATE_ROOTS = [
  'C:\\鸿蒙开发工具\\cangjie\\cangjie-1.1.0\\tools\\bin\\cjpm.exe',
  'C:\\cangjie113\\tools\\bin\\cjpm.exe',
];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function findCjpm(): Promise<string> {
  if (process.env.HM_CJPM) return process.env.HM_CJPM;
  const probe = await run('cjpm', ['--version'], 8000);
  if (probe.ok) return 'cjpm';
  for (const p of CJPM_CANDIDATE_ROOTS) if (await exists(p)) return p;
  return '';
}

function cjpmHome(cjpm: string): string | null {
  // <root>/tools/bin/cjpm.exe -> <root>. Only meaningful for an absolute
  // install path; the PATH alias already carries its own environment, and a
  // wrong CANGJIE_HOME is precisely the Windows pitfall the skill warns of.
  if (!/^[a-zA-Z]:[\\/]/.test(cjpm)) return null;
  return resolve(cjpm, '..', '..', '..');
}

async function run(cmd: string, args: string[], timeoutMs = 20_000, cwd?: string, extraEnv?: Record<string, string>): Promise<{ ok: boolean; out: string }> {
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

/** Walk up looking for a cjpm project marker. */
async function findCjpmRoot(start: string): Promise<string> {
  let dir = resolve(start);
  for (;;) {
    if (await exists(join(dir, 'cjpm.toml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

async function cjpmEnv(): Promise<{ cjpm: string; env: Record<string, string> } | { error: string }> {
  const cjpm = await findCjpm();
  if (!cjpm) {
    return { error: 'cjpm not found. Install the Cangjie toolchain, add it to PATH, or set HM_CJPM to cjpm.exe.' };
  }
  const env: Record<string, string> = {};
  const home = cjpmHome(cjpm);
  if (home && !process.env.CANGJIE_HOME) env.CANGJIE_HOME = home;
  return { cjpm, env };
}

export const harmonyCjpmBuild: Tool = {
  name: 'harmony_cjpm_build',
  description:
    'Build a Cangjie (cjpm) package with cjpm build. Looks for cjpm.toml at/above the given path (default cwd). Injects CANGJIE_HOME derived from the resolved cjpm.exe - the classic Windows pitfall. Long-running: allow minutes.',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'directory containing cjpm.toml (default: auto-detect from cwd)' },
      release: { type: 'boolean', description: 'build in release mode (default false)' },
    },
    required: [],
  },
  async execute(args, ctx) {
    const e = await cjpmEnv();
    if ('error' in e) return { output: e.error, isError: true };
    const start = typeof args.project === 'string' && args.project ? resolve(ctx.cwd, args.project) : ctx.cwd;
    const root = await findCjpmRoot(start);
    if (!root) return { output: `No cjpm project found at or above ${start} (looking for cjpm.toml).`, isError: true };
    const r = await run(e.cjpm, ['build', ...(args.release === true ? ['--release'] : [])], 900_000, root, e.env);
    const ok = r.ok && (/build finished/i.test(r.out) || !/error/i.test(r.out));
    const tail = r.out.length > 4000 ? '...\n' + r.out.slice(-4000) : r.out;
    return { output: `project: ${root}\ncjpm: ${e.cjpm}\n${tail}`, isError: !ok };
  },
};

export const harmonyCjpmTest: Tool = {
  name: 'harmony_cjpm_test',
  description: 'Run Cangjie unit tests (cjpm test) in the project at/above the given path. Same CANGJIE_HOME injection as harmony_cjpm_build.',
  parameters: {
    type: 'object',
    properties: { project: { type: 'string', description: 'directory containing cjpm.toml (default: auto-detect from cwd)' } },
    required: [],
  },
  async execute(args, ctx) {
    const e = await cjpmEnv();
    if ('error' in e) return { output: e.error, isError: true };
    const start = typeof args.project === 'string' && args.project ? resolve(ctx.cwd, args.project) : ctx.cwd;
    const root = await findCjpmRoot(start);
    if (!root) return { output: `No cjpm project found at or above ${start}.`, isError: true };
    const r = await run(e.cjpm, ['test'], 900_000, root, e.env);
    const tail = r.out.length > 4000 ? '...\n' + r.out.slice(-4000) : r.out;
    return { output: `project: ${root}\n${tail}`, isError: !r.ok };
  },
};
