import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runPatchSandbox, type CodePatch } from '../patches.ts';

const execCb = promisify(execFile);

/** git with PATH fallback (test-process PATH lacks git on this machine;
 *  .cmd shims can't execFile-spawn on modern Node - prefer real .exe). */
async function git(args: string[], cwd: string): Promise<{ stdout: string }> {
  const { homedir } = await import('node:os');
  const home = homedir();
  const candidates = [
    'git',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\Common7\\IDE\\CommonExtensions\\Microsoft\\TeamFoundation\\Team Explorer\\Git\\cmd\\git.exe',
  ];
  for (const exe of candidates) {
    try {
      return (await execCb(exe, args, { cwd, timeout: 20_000, windowsHide: true })) as { stdout: string };
    } catch (err) {
      const msg = String(err);
      if (!/ENOENT|not found/i.test(msg) && !/EINVAL/i.test(msg)) throw err;
    }
  }
  // last resort: cmd shim through the shell
  return (await execCb(join(home, '.local', 'bin', 'git.cmd'), args, { cwd, timeout: 20_000, shell: true, windowsHide: true })) as { stdout: string };
}

test('sandbox cycle end-to-end: pass merges to main; fail reverts with zero residue', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hmh-sbx-'));
  // minimal npm repo whose "build" just echoes (fast, deterministic)
  await mkdir(join(repo, 'packages/agent/src'), { recursive: true });
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 't', private: true, scripts: { build: 'node -e "process.exit(0)"' } }), 'utf8');
  const target = join(repo, 'packages/agent/src/tool.ts');
  await writeFile(target, 'export const greet = (): string => "hi";\n', 'utf8');
  // git init + first commit (main branch)
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.email', 't@t'], repo);
  await git(['config', 'user.name', 't'], repo);
  await git(['add', '-A'], repo);
  await git(['commit', '-m', 'init', '--no-verify'], repo);

  const patch: CodePatch = {
    name: 'greet-loud',
    description: 'shout',
    file: 'packages/agent/src/tool.ts',
    find: '"hi"',
    replace: '"HI!"',
    reason: 'test',
  };

  // Case A: bench passes (rate >= baseline) -> merged to main
  const merged = await runPatchSandbox({
    repoRoot: repo,
    patch,
    baselineRate: 0,
    runCase: async () => 'HI!',
    benchCases: [{ name: 'c1', prompt: 'x', expect: ['HI!'], tools: false, holdout: false }],
    log: () => undefined,
  });
  assert.equal(merged.action, 'merged', 'case A should merge: ' + JSON.stringify(merged));
  const afterMerge = await readFile(target, 'utf8');
  assert.ok(afterMerge.includes('HI!'), 'patch landed on main');
  const branchesA = (await git(['branch'], repo)).stdout;
  assert.ok(!branchesA.includes('evolve/'), 'sandbox branch deleted after merge');

  // Case B: bench regresses -> reverted, main keeps the merged state, branch gone
  const reverted = await runPatchSandbox({
    repoRoot: repo,
    patch: { ...patch, name: 'greet-broken', find: '"HI!"', replace: '"broken"' },
    baselineRate: 0.9,
    runCase: async () => 'broken',
    benchCases: [{ name: 'c1', prompt: 'x', expect: ['HI!'], tools: false, holdout: false }],
    log: () => undefined,
  });
  assert.equal(reverted.action, 'reverted', 'case B should revert: ' + JSON.stringify(reverted));
  const afterRevert = await readFile(target, 'utf8');
  assert.ok(afterRevert.includes('HI!') && !afterRevert.includes('broken'), 'revert restored main state');
  const branchesB = (await git(['branch'], repo)).stdout;
  assert.ok(!branchesB.includes('evolve/'), 'sandbox branch deleted after revert');
  const statusB = (await git(['status', '--porcelain'], repo)).stdout.trim();
  assert.equal(statusB, '', 'working tree clean after full cycle');

  await rm(repo, { recursive: true, force: true });
});
