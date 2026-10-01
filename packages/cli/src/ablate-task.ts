/**
 * @hmharness/cli - `hmh cognitive ablate-task` (blueprint §26, working domain)
 *
 * ARC ablation measures the CEILING (models fail there, harness gain is not
 * measurable yet — honest zero). This one measures the WORKING RANGE: on
 * verifiable terminal tasks where the model is competent, does the cognitive
 * context (tool-reliability digest) change task success?
 *
 *   arm A (cognitive): normal runner (digest injected when evidence exists)
 *   arm B (bare):      HMH_NO_COGNITIVE=1 strips the digest
 *
 * Difficulty bands: easy/mid/hard (author-designed, all measured FLOOR) and
 * `bench` — REAL corpus cases from evolution's bench with the structured
 * assertion engine (matchCase), the natural 20-80% failure-rate sample
 * source. Calibration (`--calibrate`) gates admission to the measurable
 * band before any ablation spends runtime. Results append to
 * cognitive/ablation.jsonl (type: 'terminal-task').
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;

interface AblateTask {
  text: string;
  label: string;
  check: (output: string) => boolean;
}

const bySubstring = (expect: string) => (output: string): boolean => output.includes(expect);

/** deterministic, verifiable mini-tasks (exact substring must appear) */
const TASKS: AblateTask[] = [
  { text: '用 read_file 读取 G:/hmharness/package.json，只回复 "name" 字段的精确值，不要其他文字。', label: 'field-extract', check: bySubstring('hmharness') },
  { text: '用 read_file 读取 G:/hmharness/README.md 的第一行，只回复该行内容。', label: 'first-line', check: bySubstring('#') },
  { text: '用 run_command 执行 node -e "console.log(21*2)"，只回复输出数字。', label: 'compute', check: bySubstring('42') },
  { text: '用 list_dir 列出 G:/hmharness/packages 下名为 kernel 的目录是否存在，只回复 是 或 否。', label: 'exists-check', check: bySubstring('是') },
];

/**
 * MID band: multi-step extraction (author-designed; measured FLOOR — kept
 * for the difficulty-spectrum record, not for measurable gain).
 */
const MID_TASKS: AblateTask[] = [
  { text: '用 read_file 读取 G:/hmharness/packages/kernel/src/index.ts，统计包含 export 的行数，只回复该数字。', label: 'count-export', check: bySubstring('16') },
  { text: '读取 G:/hmharness/packages/cli/package.json，按字母序只列出全部 @hmharness 开头的依赖名，逗号分隔不要空格。', label: 'sorted-deps', check: bySubstring('@hmharness/agent,@hmharness/cognitive,@hmharness/domain-harmony,@hmharness/domain-ops,@hmharness/environments,@hmharness/evaluation,@hmharness/evolution,@hmharness/kernel,@hmharness/observability,@hmharness/sandbox,@hmharness/web') },
  { text: '读取 G:/hmharness/package.json 的 version 字段，计算 主版本+次版本+修订版 三个数字之和，只回复数字。', label: 'version-sum', check: bySubstring('23') },
  { text: '用 list_dir 查看 G:/hmharness/packages/cognitive/src/__tests__ 目录，统计其中 .test.ts 结尾的文件个数，只回复数字。', label: 'count-tests', check: bySubstring('5') },
];

/**
 * HARD band: cross-file aggregation (author-designed; measured FLOOR).
 */
const HARD_TASKS: AblateTask[] = [
  { text: '分别读取 G:/hmharness/packages/kernel/src/index.ts 和 G:/hmharness/packages/agent/src/index.ts 两个文件，统计两个文件中包含 export 的行数总和，只回复该数字。', label: 'cross-file-count', check: bySubstring('29') },
  { text: '读取 G:/hmharness/packages/web/package.json，只回复 dependencies 中 qrcode 这一项的精确版本约束字符串（含符号），不要其他文字。', label: 'dep-constraint', check: bySubstring('^1.5.4') },
  { text: '统计 G:/hmharness/packages/cognitive/src/__tests__ 和 G:/hmharness/packages/environments/src/__tests__ 两个目录中 .test.ts 结尾文件的总个数，只回复数字。', label: 'cross-dir-count', check: bySubstring('9') },
  { text: '读取 G:/hmharness/package.json 的 version 字段，把其中的点全部换成短横线后回复结果，不要其他文字。', label: 'version-dashes', check: bySubstring('0-21-3') },
];

/** BENCH band: real corpus cases with the structured assertion engine. */
async function benchPool(home: string, filter?: string, limit = 8): Promise<AblateTask[]> {
  const { listCases, matchCase } = await import('@hmharness/evolution');
  const cases = await listCases(home);
  return cases
    .filter((c) => !c.holdout)
    .filter((c) => (filter ? c.name.startsWith(filter) : true))
    .slice(0, limit)
    .map((c) => ({
      text: c.prompt,
      label: `bench:${c.name}`,
      check: (out: string) => matchCase(out, c).pass,
    }));
}

async function poolOf(difficulty: 'easy' | 'mid' | 'hard' | 'bench', home: () => string, filter?: string): Promise<AblateTask[]> {
  if (difficulty === 'bench') return benchPool(home(), filter);
  if (difficulty === 'hard') return HARD_TASKS;
  if (difficulty === 'mid') return MID_TASKS;
  return TASKS;
}

/**
 * One agent run IN-PROCESS, capturing the FINAL reply text — the exact same
 * extraction the bench gate uses. (The earlier subprocess version captured
 * raw stdout: thinking blocks + session lines + ANSI noise broke expect-exact
 * assertions — a measurement artifact that misread "model fails" when the
 * harness output was merely verbose. Same instrument, same reading.)
 */
async function runOnce(task: string, bare: boolean, timeoutMs: number): Promise<{ ok: boolean; output: string; error?: string }> {
  const prev = process.env.HMH_NO_COGNITIVE;
  if (bare) process.env.HMH_NO_COGNITIVE = '1';
  else delete process.env.HMH_NO_COGNITIVE;
  let finalText = '';
  try {
    const { runAgentTask, buildRegistry } = await import('@hmharness/agent');
    const { loadConfig } = await import('@hmharness/kernel');
    const { reg } = await buildRegistry({ mcp: false });
    await Promise.race([
      runAgentTask({
        task,
        registry: reg,
        cfg: await loadConfig(),
        yes: true,
        events: { onFinal: (r: { text: string }) => { finalText = r.text; } },
      } as never),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ablate run timeout')), timeoutMs)),
    ]).catch((err: unknown) => {
      if (!finalText) throw err;
      return undefined;
    });
    return { ok: true, output: finalText };
  } catch (err) {
    // a crashed run is a FAILED run (honest reading): record it and keep the
    // ablation alive — one transient provider 400 must not kill the whole
    // experiment and lose every arm's data
    return { ok: false, output: finalText, error: String(err).slice(0, 120) };
  } finally {
    if (prev === undefined) delete process.env.HMH_NO_COGNITIVE;
    else process.env.HMH_NO_COGNITIVE = prev;
  }
}

/** A run's outcome, signal-separated: a crash (timeout/rate-limit/provider)
 *  is INFRASTRUCTURE noise, not the model answering wrong — mixing them
 *  poisons the effect estimate (the -8.3% artifact). Crash = the run did
 *  not complete (r.ok === false) regardless of whether a partial onFinal
 *  reply exists — a timed-out arm is a crash even when it had replied. */
type RunVerdict = 'pass' | 'wrong' | 'crash';

export function verdictOf(r: { ok: boolean; output: string; error?: string }, check: (out: string) => boolean): RunVerdict {
  if (!r.ok) return 'crash'; // run died (timeout / rate-limit / provider error)
  return check(r.output) ? 'pass' : 'wrong';
}

export async function runTaskAblation(write: (s: string) => void, home: () => string, runs: number, difficulty: 'easy' | 'mid' | 'hard' | 'bench' = 'easy', filter?: string): Promise<void> {
  const homeDir = home();
  const pool = await poolOf(difficulty, home, filter);
  write(`Terminal 域消融 · ${difficulty} 难度 · ${pool.length} 个可验证任务 × ${runs} 轮 × 双臂（§26 工作域测量）\n`);
  let withOk = 0;
  let bareOk = 0;
  let total = 0;
  let withCrash = 0;
  let bareCrash = 0;
  let cleanPairs = 0; // pairs where BOTH arms produced a reply (model-vs-model)
  const details: Array<{ label: string; with: string; bare: string }> = [];
  for (let r = 1; r <= runs; r++) {
    for (const t of pool) {
      total += 1;
      const a = await runOnce(t.text, false, 240_000);
      const b = await runOnce(t.text, true, 240_000);
      const av = verdictOf(a, t.check);
      const bv = verdictOf(b, t.check);
      if (av === 'crash') withCrash += 1;
      if (bv === 'crash') bareCrash += 1;
      if (av !== 'crash' && bv !== 'crash') {
        cleanPairs += 1;
        withOk += av === 'pass' ? 1 : 0;
        bareOk += bv === 'pass' ? 1 : 0;
      }
      details.push({ label: t.label, with: av, bare: bv });
      const mark = (v: RunVerdict): string => (v === 'pass' ? GREEN('✓') : v === 'wrong' ? RED('✗') : YELLOW('⚡'));
      const note = av === 'crash' || bv === 'crash' ? DIM(`  ⚡ ${String(a.error ?? b.error).slice(0, 60)}`) : '';
      write(`  ${t.label.padEnd(24)} 认知 ${mark(av)} · 裸 ${mark(bv)}${note}\n`);
    }
  }
  const record = {
    at: new Date().toISOString(),
    type: 'terminal-task',
    difficulty,
    runs,
    // clean stats: only pairs where both arms answered (model-vs-model)
    withCognitive: { pass: withOk, total: cleanPairs },
    bare: { pass: bareOk, total: cleanPairs },
    crashes: { withArm: withCrash, bareArm: bareCrash },
    harnessDelta: cleanPairs ? Number(((withOk - bareOk) / cleanPairs).toFixed(3)) : null,
    details,
  };
  await mkdir(join(homeDir, 'cognitive'), { recursive: true }).catch(() => undefined);
  await appendFile(join(homeDir, 'cognitive', 'ablation.jsonl'), JSON.stringify(record) + '\n', 'utf8').catch(() => undefined);
  write(`结论 · 认知层 ${withOk}/${cleanPairs} vs 裸 ${bareOk}/${cleanPairs}（干净对 ${cleanPairs}/${total}，⚡基础设施中断 认知${withCrash}/裸${bareCrash} 已剔除）`);
  write(record.harnessDelta === null ? ' → 干净对不足，无读数\n' : ` → harness 结果层净贡献 ${(record.harnessDelta * 100).toFixed(1)}%\n`);
  write(DIM('（⚡=超时/限流/provider 错误：非模型答错，混入会污染效应估计——v0.22.2 教训）\n'));
}

/**
 * Bare-arm calibration (the v0.21.3 lesson, implemented): BEFORE an ablation
 * claims a band is measurable, run each candidate task bare and measure its
 * actual failure rate. Admission to the measurable band is 20-80% bare
 * failure — the author's intuition about difficulty is not the instrument.
 */
export async function runBareCalibration(write: (s: string) => void, difficulty: 'easy' | 'mid' | 'hard' | 'bench', probes: number, home: () => string, filter?: string): Promise<void> {
  const pool = await poolOf(difficulty, home, filter);
  write(`裸臂定标 · ${difficulty} 难度 · ${pool.length} 任务 × ${probes} 次裸跑（准入带=失败率 20%-80%）\n`);
  for (const t of pool) {
    let fails = 0;
    for (let i = 0; i < probes; i++) {
      const r = await runOnce(t.text, true, 240_000);
      if (!r.ok || !t.check(r.output)) fails += 1; // a crashed probe counts as a bare failure (infrastructure, not model-competence — note it in the band reading)
    }
    const rate = Number((fails / probes).toFixed(2));
    const band = rate === 0 ? '地板（剔除）' : rate >= 1 ? '天花板（剔除）' : rate >= 0.2 && rate <= 0.8 ? '可测带 ✓' : '边缘';
    write(`  ${t.label.padEnd(24)} 裸失败率 ${Math.round(rate * 100)}% → ${band}\n`);
  }
  write(DIM('  定标纪律:只有可测带任务进消融池;地板/天花板任务测不出处理效应\n'));
}
