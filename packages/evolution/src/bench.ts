/**
 * @hmh/evolution - bench
 * The fitness signal for self-evolution: bench/cases/*.task files are
 * one-line prompts with expected-substring checks; runBench() replays them
 * through the real loop and scores pass/fail. Skill or prompt changes must
 * keep the bench green before promotion (Phase 3 wires this into the
 * evolution loop automatically).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BenchCase {
  name: string;
  prompt: string;
  expect: string;
}

export interface BenchResult {
  name: string;
  pass: boolean;
  detail: string;
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
    // format: line1 = prompt, line2 = "expect: substring"
    const lines = raw.split('\n');
    const prompt = lines[0];
    const expectLine = lines.find((l) => l.startsWith('expect:'));
    cases.push({ name: f.replace(/\.task$/, ''), prompt, expect: expectLine ? expectLine.slice(7).trim() : '' });
  }
  return cases;
}

export async function runBench(
  home: string,
  run: (prompt: string) => Promise<string>,
): Promise<{ results: BenchResult[]; passRate: number }> {
  const cases = await listCases(home);
  const results: BenchResult[] = [];
  for (const c of cases) {
    try {
      const out = await run(c.prompt);
      const pass = !c.expect || out.toLowerCase().includes(c.expect.toLowerCase());
      results.push({ name: c.name, pass, detail: pass ? 'ok' : `missing "${c.expect}" in output` });
    } catch (err) {
      results.push({ name: c.name, pass: false, detail: String(err).slice(0, 120) });
    }
  }
  const passed = results.filter((r) => r.pass).length;
  return { results, passRate: cases.length === 0 ? 1 : passed / cases.length };
}
