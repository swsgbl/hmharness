/**
 * @hmh/evolution - patches
 * CODE-LEVEL self-evolution: the evolution loop can now propose source-code
 * patches (not just prompt-level skills), test them on an isolated git
 * branch, and merge or revert based on the benchmark gate.
 *
 * The Darwin Gödel Machine insight: an agent that can only take notes
 * (skills/memory) learns WHAT to do; an agent that can patch its own code
 * learns WHAT IT CAN DO. This module is the bridge.
 *
 * Safety model (same shape as the skill gate, extended to code):
 *  1. patches may only modify files under packages/.../src/ (never config,
 *     never security code, never the kernel loop itself)
 *  2. every patch runs on a git branch (sandbox), never on main
 *  3. the bench gate must show no regression (same double-sample rule)
 *  4. revert = git checkout main + branch delete (zero residue)
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execCb = promisify(execFile);

/** A proposed code change: find-and-replace in one source file. */
export interface CodePatch {
  name: string;
  description: string;
  /** relative path from repo root, must match packages/.../src/.../*.ts */
  file: string;
  /** exact string to find in the file (must be unique) */
  find: string;
  /** replacement string */
  replace: string;
  /** why this change helps (for the audit log) */
  reason: string;
}

export interface PatchOutcome {
  name: string;
  action: 'merged' | 'reverted' | 'error';
  reason: string;
  branch?: string;
}

/** Guard: only source files inside packages, never kernel internals. */
export function isPatchableFile(file: string): boolean {
  if (!/^packages\/[a-z-]+\/src\/[a-zA-Z0-9_/.-]+\.ts$/.test(file)) return false;
  // never allow patching the kernel loop itself (bootstrapping paradox)
  if (file.startsWith('packages/kernel/src/loop')) return false;
  if (file.startsWith('packages/kernel/src/provider')) return false;
  // never config or security
  if (/config|security|mcp/.test(file)) return false;
  return true;
}

/** Validate + apply a patch to a file on disk. Returns error if find-string
 *  is not found or not unique. */
export async function applyPatch(repoRoot: string, patch: CodePatch): Promise<string> {
  if (!isPatchableFile(patch.file)) {
    return `refused: ${patch.file} is not a patchable source file (must be packages/*/src/*.ts, not kernel loop/provider/config)`;
  }
  const filePath = join(repoRoot, patch.file);
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return `file not found: ${patch.file}`;
  }
  const count = content.split(patch.find).length - 1;
  if (count === 0) return `find-string not found in ${patch.file}`;
  if (count > 1) return `find-string appears ${count}x in ${patch.file} (must be unique)`;
  const patched = content.replace(patch.find, patch.replace);
  await writeFile(filePath, patched, 'utf8');
  return 'applied';
}

/** Create a sandbox git branch for testing a patch. */
export async function createSandbox(repoRoot: string, name: string): Promise<string> {
  const branch = `evolve/${name}-${Date.now().toString(36)}`;
  await execCb('git', ['checkout', '-b', branch], { cwd: repoRoot, timeout: 10_000 });
  return branch;
}

/** Run the bench gate on the current branch. Returns pass rate (0-1) or -1 on build failure. */
export async function sandboxBench(
  repoRoot: string,
  runCase: (c: import('./bench.ts').BenchCase, skillsPrompt: string) => Promise<string>,
  cases: import('./bench.ts').BenchCase[],
): Promise<number> {
  // rebuild all packages (the patch may affect any layer)
  try {
    await execCb('npm', ['run', 'build'], { cwd: repoRoot, timeout: 120_000, windowsHide: true });
  } catch {
    return -1; // build failed = automatic reject
  }
  // double-sample rule: each case must pass BOTH runs
  let pass = 0;
  for (const c of cases) {
    let ok = true;
    for (let i = 0; i < 2 && ok; i++) {
      try {
        const out = await runCase(c, '');
        ok = c.expect.every((e) => out.toLowerCase().includes(e.toLowerCase()));
      } catch {
        ok = false;
      }
    }
    if (ok) pass++;
  }
  return cases.length > 0 ? pass / cases.length : -1;
}

/** Merge the sandbox branch back to main (patch promoted). */
export async function mergeSandbox(repoRoot: string, branch: string): Promise<void> {
  await execCb('git', ['checkout', 'main'], { cwd: repoRoot, timeout: 10_000 });
  await execCb('git', ['merge', '--no-edit', branch], { cwd: repoRoot, timeout: 15_000 });
  await execCb('git', ['branch', '-D', branch], { cwd: repoRoot, timeout: 5000 });
}

/** Revert: go back to main, delete the sandbox branch (zero residue). */
export async function revertSandbox(repoRoot: string, branch: string): Promise<void> {
  await execCb('git', ['checkout', 'main'], { cwd: repoRoot, timeout: 10_000 });
  // discard any uncommitted changes on the sandbox branch
  await execCb('git', ['reset', '--hard', 'HEAD'], { cwd: repoRoot, timeout: 5000 });
  await execCb('git', ['branch', '-D', branch], { cwd: repoRoot, timeout: 5000 });
}

/**
 * Full sandbox cycle: apply patch on a branch, rebuild, bench, merge or revert.
 * This is the CODE-LEVEL equivalent of the skill A/B gate.
 */
export async function runPatchSandbox(opts: {
  repoRoot: string;
  patch: CodePatch;
  baselineRate: number;
  runCase: (c: import('./bench.ts').BenchCase, skillsPrompt: string) => Promise<string>;
  benchCases: import('./bench.ts').BenchCase[];
  log?: (line: string) => void;
}): Promise<PatchOutcome> {
  const say = opts.log ?? (() => undefined);
  const { patch } = opts;
  say(`  code-patch "${patch.name}": creating sandbox branch`);
  let branch = '';
  try {
    branch = await createSandbox(opts.repoRoot, patch.name);
    const applyResult = await applyPatch(opts.repoRoot, patch);
    if (applyResult !== 'applied') {
      await revertSandbox(opts.repoRoot, branch);
      return { name: patch.name, action: 'error', reason: applyResult, branch };
    }
    say(`  code-patch "${patch.name}": applied, rebuilding + benching`);
    const rate = await sandboxBench(opts.repoRoot, opts.runCase, opts.benchCases);
    if (rate < 0) {
      await revertSandbox(opts.repoRoot, branch);
      return { name: patch.name, action: 'reverted', reason: 'build failed in sandbox', branch };
    }
    if (rate < opts.baselineRate) {
      await revertSandbox(opts.repoRoot, branch);
      return { name: patch.name, action: 'reverted', reason: `bench ${rate} < baseline ${opts.baselineRate}`, branch };
    }
    say(`  code-patch "${patch.name}": bench ${rate} >= baseline ${opts.baselineRate}, merging`);
    await mergeSandbox(opts.repoRoot, branch);
    return { name: patch.name, action: 'merged', reason: `bench ${rate} >= baseline (merged to main)`, branch };
  } catch (err) {
    if (branch) {
      try { await revertSandbox(opts.repoRoot, branch); } catch { /* best effort */ }
    }
    return { name: patch.name, action: 'error', reason: String(err).slice(0, 200), branch };
  }
}

/**
 * Meta-model call: propose code patches from session signals.
 * The model sees the signals + the target file's current source and
 * outputs find/replace pairs. Constrained to optimization prompts:
 * fix a bug, speed up a hot path, improve error messages.
 */
export async function proposePatches(
  provider: { baseUrl: string; apiKey: string; model: string },
  signals: Record<string, unknown>,
  readFileFn: typeof readFile,
  repoRoot: string,
  say: (l: string) => void,
): Promise<CodePatch[]> {
  // pick candidate files: the most-used tools from insights
  const toolFiles: Record<string, string> = {
    run_command: 'packages/agent/src/tools.ts',
    web_search: 'packages/agent/src/tools.ts',
    web_fetch: 'packages/agent/src/tools.ts',
    harmony_build: 'packages/domain-harmony/src/index.ts',
    harmony_devices: 'packages/domain-harmony/src/devices.ts',
    // add more as insights reveal hot paths
  };
  const toolsUsed = (signals.toolUsage ?? {}) as Record<string, number>;
  const hotTools = Object.entries(toolsUsed)
    .filter(([t]) => toolFiles[t])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([t]) => t);
  if (hotTools.length === 0) return [];

  const fileContents: Record<string, string> = {};
  for (const t of hotTools) {
    const f = toolFiles[t];
    try {
      fileContents[f] = (await readFileFn(join(repoRoot, f), 'utf8')).slice(0, 6000);
    } catch { /* skip */ }
  }

  const system = [
    'You are the code-evolution module of hmharness. Given session signals and the CURRENT source of the most-used tool files, propose at most 1 code patch as a JSON object.',
    'A patch is: {"name":"kebab-case","description":"one line","file":"packages/.../src/...ts","find":"exact string from the source (must be unique)","replace":"the improved code","reason":"why"}',
    'Rules: ONLY optimize what the signals show is slow/broken/verbose. Keep patches SMALL (under 20 lines of change). Do NOT restructure. Do NOT touch security, config, or the agent loop. If nothing genuinely needs a code fix, return [].',
    'Respond with ONLY a JSON array.',
  ].join('\n');
  const user = `Session signals:\n${JSON.stringify(signals, null, 2)}\n\nHot tool source files:\n${JSON.stringify(fileContents, null, 2)}\n\nPropose at most 1 patch (or []).`;
  say('  code-evolution: asking meta-model for patch proposals');
  try {
    const { chat } = await import('@hmh/kernel');
    const r = await chat(provider, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    const text = r.message.content ?? '[]';
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end < 0) return [];
    const parsed = JSON.parse(text.slice(start, end + 1)) as CodePatch[];
    return parsed.filter((p) => p.file && p.find && p.replace && isPatchableFile(p.file));
  } catch {
    return [];
  }
}
