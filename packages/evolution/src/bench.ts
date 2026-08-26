/**
 * @hmh/evolution - bench
 * The fitness signal for self-evolution. bench/cases/*.task files are:
 *   line 1        the prompt
 *   expect: a && b   substrings that must ALL appear in the final output
 *   tools: loop   (optional) run through the full agent loop with tools
 * Skill or prompt changes must keep the bench green before promotion - the
 * evolve loop enforces this A/B (baseline vs candidate).
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BenchCase {
  name: string;
  prompt: string;
  /** All substrings (split on &&) must appear in the output, case-insensitive. */
  expect: string[];
  /** When true the case runs through the full agent loop with tools. */
  tools: boolean;
}

export interface BenchResult {
  name: string;
  pass: boolean;
  detail: string;
}

export function matchExpect(output: string, expect: string[]): boolean {
  const lower = output.toLowerCase();
  return expect.every((e) => lower.includes(e.toLowerCase()));
}

export async function listCases(home: string): Promise<BenchCase[]> {
  const dir = join(home, 'bench', 'cases');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.task'));
  } catch {
    return [];
  }
  const cases: BenchCase[] = [];
  for (const f of files.sort()) {
    const raw = (await readFile(join(dir, f), 'utf8')).trim();
    const lines = raw.split('\n');
    const prompt = lines[0];
    const expectLine = lines.find((l) => l.startsWith('expect:'));
    const toolsLine = lines.find((l) => l.startsWith('tools:'));
    cases.push({
      name: f.replace(/\.task$/, ''),
      prompt,
      expect: expectLine ? expectLine.slice(7).split('&&').map((s) => s.trim()).filter(Boolean) : [],
      tools: toolsLine ? toolsLine.slice(6).trim() === 'loop' : false,
    });
  }
  return cases;
}

export async function runBench(
  home: string,
  run: (c: BenchCase) => Promise<string>,
): Promise<{ results: BenchResult[]; passRate: number }> {
  const cases = await listCases(home);
  const results: BenchResult[] = [];
  for (const c of cases) {
    try {
      const out = await run(c);
      const pass = matchExpect(out, c.expect);
      results.push({ name: c.name, pass, detail: pass ? 'ok' : `missing "${c.expect.join('" && "')}" in output` });
    } catch (err) {
      results.push({ name: c.name, pass: false, detail: String(err).slice(0, 120) });
    }
  }
  const passed = results.filter((r) => r.pass).length;
  return { results, passRate: cases.length === 0 ? 1 : passed / cases.length };
}

/** Starter cases so the evolve gate has a signal from day one. */
export async function seedCases(home: string): Promise<string[]> {
  const dir = join(home, 'bench', 'cases');
  const written: string[] = [];
  const seeds: Array<[string, string]> = [
    ['toolchain-report.task', '运行鸿蒙工具链体检,然后逐项说出一共检查了哪三个工具的名称\nexpect: hdc && hvigorw && ohpm\ntools: loop\n'],
    ['reply-determinism.task', '只回复这六个字符,不要任何其他内容:HMH-OK\nexpect: HMH-OK\n'],
  ];
  let existing: string[] = [];
  try {
    existing = await readdir(dir);
  } catch {
    /* first seed */
  }
  for (const [name, body] of seeds) {
    if (existing.includes(name)) continue;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), body, 'utf8');
    written.push(name);
  }
  return written;
}
