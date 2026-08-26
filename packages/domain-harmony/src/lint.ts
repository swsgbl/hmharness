/**
 * @hmh/domain-harmony - lint (codelinter wrapper, probe-based)
 * The official codelinter CLI wrapped as a tool. Probe-first: if the CLI
 * isn't installed locally the tool explains exactly what to install rather
 * than failing opaquely. Flag surface kept to the minimum verified subset.
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '@hmh/kernel';

const exec = promisify(execFile);

function devecoHome(): string {
  return process.env.HM_DEVECO_HOME ?? 'C:\\DevEco-Studio';
}

async function findCodelinter(): Promise<string> {
  if (process.env.HM_CODELINTER) return process.env.HM_CODELINTER;
  try {
    await exec('codelinter', ['--version'], { timeout: 8000, windowsHide: true });
    return 'codelinter';
  } catch {
    /* not on PATH */
  }
  for (const c of ['codelinter.bat', 'codelinter.exe', 'codelinter']) {
    const p = join(devecoHome(), 'tools', 'codelinter', 'bin', c);
    try {
      await access(p);
      return p;
    } catch {
      /* next */
    }
  }
  return '';
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
        output: 'codelinter not found. Install DevEco Studio Command Line Tools (codelinter component) or set HM_CODELINTER to its executable. Probe checked PATH and ' + join(devecoHome(), 'tools', 'codelinter', 'bin') + '.',
        isError: true,
      };
    }
    const dir = typeof args.project === 'string' && args.project ? join(ctx.cwd, args.project) : ctx.cwd;
    try {
      const { stdout, stderr } = await exec(bin, [dir], { timeout: 300_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      const out = (stdout || stderr || '(no findings)').trim();
      return { output: out.length > 20_000 ? out.slice(0, 20_000) + '\n...[truncated]' : out };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').slice(0, 8000), isError: true };
    }
  },
};
