/**
 * @hmh/domain-harmony - lint (codelinter wrapper, probe-based)
 * The official codelinter CLI wrapped as a tool. Probe-first: if the CLI
 * isn't installed locally the tool explains exactly what to install rather
 * than failing opaquely. Flag surface kept to the minimum verified subset.
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '@hmh/kernel';

const exec = promisify(execFile);

function devecoHome(): string {
  return process.env.HM_DEVECO_HOME ?? 'C:\\DevEco-Studio';
}

/** Returns a launcher: either the bare command or [node, <run/index.js>]. */
async function findCodelinter(): Promise<{ cmd: string; args: string[] } | null> {
  if (process.env.HM_CODELINTER) return { cmd: process.env.HM_CODELINTER, args: [] };
  try {
    await exec('codelinter', ['--version'], { timeout: 8000, windowsHide: true });
    return { cmd: 'codelinter', args: [] };
  } catch {
    /* not on PATH */
  }
  // DevEco ships codelinter as a plugin with a node CLI entry
  const entry = join(devecoHome(), 'plugins', 'codelinter', 'run', 'index.js');
  try {
    await access(entry);
    return { cmd: process.execPath, args: [entry] };
  } catch {
    return null;
  }
}

export const harmonyLint: Tool = {
  name: 'harmony_lint',
  description:
    'Lint a HarmonyOS/ArkTS project with the official codelinter CLI (probe-based). If codelinter is not installed, returns install guidance instead of failing. Install options: DevEco Studio "Command Line Tools" component, then set HM_CODELINTER or add it to PATH.',
  parameters: {
    type: 'object',
    properties: { project: { type: 'string', description: 'project directory to lint (default: cwd)' },
    },
    required: [],
  },
  async execute(args, ctx) {
    const bin = await findCodelinter();
    if (!bin) {
      return {
        output: 'codelinter not found. Install DevEco Studio (its codelinter plugin) or set HM_CODELINTER. Probed PATH and ' + join(devecoHome(), 'plugins', 'codelinter', 'run', 'index.js') + '.',
        isError: true,
      };
    }
    const projArg = typeof args.project === 'string' && args.project ? args.project : ctx.cwd;
    const dir = isAbsolute(projArg) ? projArg : resolve(ctx.cwd, projArg);
    try {
      const { stdout, stderr } = await exec(bin.cmd, [...bin.args, dir], { timeout: 300_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      const out = (stdout || stderr || '(no findings)').trim();
      return { output: out.length > 20_000 ? out.slice(0, 20_000) + '\n...[truncated]' : out };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').slice(0, 8000), isError: true };
    }
  },
};
