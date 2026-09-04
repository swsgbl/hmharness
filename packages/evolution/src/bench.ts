/**
 * @hmh/evolution - bench
 * The fitness signal for self-evolution. bench/cases/*.task files are:
 *   line 1        the prompt
 *   expect: a && b   substrings that must ALL appear in the final output
 *   expect-exact: "..."   the output equals this string (trimmed)
 *   expect-regex: ...     a regex the output must match
 *   expect-none: a && b   substrings that must NOT appear
 *   expect-any: a || b    one of these substrings must appear
 *   tools: loop   (optional) run through the full agent loop with tools
 *   cost-cap: 1.3  (optional) candidate cost multiplier ceiling vs baseline
 * Skill or prompt changes must keep the bench green before promotion - the
 * evolve loop enforces this A/B (baseline vs candidate).
 *
 * Assertion upgrade (gate methodology): plain substring matching lets
 * verbose-but-wrong outputs pass; the structured modes pin exact shapes,
 * forbid failure markers, and (with cost-cap) stop a candidate that only
 * passes by burning 3x tokens. Old files keep working - `expect:` keeps
 * its ALL-substrings semantics.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BenchCase {
  name: string;
  prompt: string;
  /** All substrings (split on &&) must appear in the output, case-insensitive. */
  expect: string[];
  /** Output must equal this string exactly (both trimmed). */
  expectExact?: string;
  /** Output must match this regex (whole output, case-sensitive). */
  expectRegex?: string;
  /** Substrings that must NOT appear (failure-marker exclusion). */
  expectNone?: string[];
  /** At least ONE of these substrings must appear. */
  expectAny?: string[];
  /** When true the case runs through the full agent loop with tools. */
  tools: boolean;
  /** Holdout cases are excluded from the promotion gate and re-verify after promotion (anti-memorization, GDPevo style). */
  holdout: boolean;
  /** Candidate token-cost ceiling as a multiple of the baseline run. */
  costCap?: number;
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

/** Full structured assertion: every declared mode must hold. */
export function matchCase(output: string, c: Pick<BenchCase, 'expect' | 'expectExact' | 'expectRegex' | 'expectNone' | 'expectAny'>): { pass: boolean; detail: string } {
  if (c.expectExact !== undefined && output.trim() !== c.expectExact.trim()) {
    return { pass: false, detail: `exact mismatch: got "${output.trim().slice(0, 80)}"` };
  }
  if (c.expectRegex !== undefined) {
    try {
      if (!new RegExp(c.expectRegex).test(output)) return { pass: false, detail: `regex mismatch: /${c.expectRegex.slice(0, 60)}/` };
    } catch {
      return { pass: false, detail: `invalid regex in case: ${c.expectRegex.slice(0, 40)}` };
    }
  }
  if (c.expectNone && c.expectNone.some((e) => output.toLowerCase().includes(e.toLowerCase()))) {
    return { pass: false, detail: `forbidden marker present: ${c.expectNone.join(' && ')}` };
  }
  if (c.expectAny && !c.expectAny.some((e) => output.toLowerCase().includes(e.toLowerCase()))) {
    return { pass: false, detail: `none of the allowed markers found: ${c.expectAny.join(' || ')}` };
  }
  if (!matchExpect(output, c.expect)) {
    return { pass: false, detail: `missing "${c.expect.join('" && "')}" in output` };
  }
  return { pass: true, detail: 'ok' };
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
    const pick = (key: string) => {
      const l = lines.find((x) => x.startsWith(key + ':'));
      return l ? l.slice(key.length + 1).trim() : undefined;
    };
    const list = (key: string) => {
      const v = pick(key);
      return v ? v.split(/&&|\|\|/).map((s) => s.trim()).filter(Boolean) : undefined;
    };
    const costCap = Number(pick('cost-cap'));
    cases.push({
      name: f.replace(/\.task$/, ''),
      prompt,
      expect: list('expect') ?? [],
      expectExact: pick('expect-exact')?.replace(/^"|"$/g, ''),
      expectRegex: pick('expect-regex'),
      expectNone: list('expect-none'),
      expectAny: list('expect-any'),
      tools: pick('tools') === 'loop',
      holdout: pick('holdout') === 'true',
      costCap: Number.isFinite(costCap) && costCap > 0 ? costCap : undefined,
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
      const r = matchCase(out, c);
      results.push({ name: c.name, pass: r.pass, detail: r.detail });
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
    ['toolchain-ohpm-status.task', '运行鸿蒙工具链体检,然后只回答 ohpm 的状态是 OK 还是 MISSING\nexpect: OK\ntools: loop\nholdout: true\n'],
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
