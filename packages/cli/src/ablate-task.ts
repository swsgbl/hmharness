/**
 * @hmharness/cli - `hmh cognitive ablate-task` (blueprint §26, working domain)
 *
 * ARC ablation measures the CEILING (models fail there, harness gain is not
 * measurable yet — honest zero). This one measures the WORKING RANGE: on
 * verifiable terminal mini-tasks where the model is competent, does the
 * cognitive context (tool-reliability digest) change task success?
 *
 *   arm A (cognitive): normal runner (digest injected when evidence exists)
 *   arm B (bare):      HMH_NO_COGNITIVE=1 strips the digest
 *
 * Same model, same task text, deterministic exact-match verification.
 * Results append to cognitive/ablation.jsonl (type: 'terminal-task').
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** deterministic, verifiable mini-tasks (exact substring must appear) */
const TASKS: Array<{ text: string; expect: string; label: string }> = [
  { text: '用 read_file 读取 G:/hmharness/package.json，只回复 "name" 字段的精确值，不要其他文字。', expect: 'hmharness', label: 'field-extract' },
  { text: '用 read_file 读取 G:/hmharness/README.md 的第一行，只回复该行内容。', expect: '#', label: 'first-line' },
  { text: '用 run_command 执行 node -e "console.log(21*2)"，只回复输出数字。', expect: '42', label: 'compute' },
  { text: '用 list_dir 列出 G:/hmharness/packages 下名为 kernel 的目录是否存在，只回复 是 或 否。', expect: '是', label: 'exists-check' },
];

function runOnce(task: string, bare: boolean, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'packages/cli/src/main.ts', '--yes', task], {
      cwd: 'G:/hmharness',
      shell: true,
      env: { ...process.env, ...(bare ? { HMH_NO_COGNITIVE: '1' } : {}) },
    });
    let out = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out });
    });
  });
}

export async function runTaskAblation(write: (s: string) => void, home: () => string, runs: number): Promise<void> {
  const homeDir = home();
  write(`Terminal 域消融 · ${TASKS.length} 个可验证任务 × ${runs} 轮 × 双臂（§26 工作域测量）\n`);
  let withOk = 0;
  let bareOk = 0;
  let total = 0;
  const details: Array<{ label: string; with: boolean; bare: boolean }> = [];
  for (let r = 1; r <= runs; r++) {
    for (const t of TASKS) {
      total += 1;
      const a = await runOnce(t.text, false, 240_000);
      const b = await runOnce(t.text, true, 240_000);
      const aHit = a.output.includes(t.expect);
      const bHit = b.output.includes(t.expect);
      withOk += aHit ? 1 : 0;
      bareOk += bHit ? 1 : 0;
      details.push({ label: t.label, with: aHit, bare: bHit });
      write(`  ${t.label.padEnd(14)} 认知 ${aHit ? GREEN('✓') : RED('✗')} · 裸 ${bHit ? GREEN('✓') : RED('✗')}\n`);
    }
  }
  const record = {
    at: new Date().toISOString(),
    type: 'terminal-task',
    runs,
    withCognitive: { pass: withOk, total },
    bare: { pass: bareOk, total },
    harnessDelta: Number(((withOk - bareOk) / total).toFixed(3)),
    details,
  };
  await mkdir(join(homeDir, 'cognitive'), { recursive: true }).catch(() => undefined);
  await appendFile(join(homeDir, 'cognitive', 'ablation.jsonl'), JSON.stringify(record) + '\n', 'utf8').catch(() => undefined);
  write(`结论 · 认知层 ${withOk}/${total} vs 裸 ${bareOk}/${total} → harness 结果层净贡献 ${(record.harnessDelta * 100).toFixed(1)}%\n`);
  write(DIM('（ARC 域测上限=诚实零;本域测工作范围=模型胜任区的结果增益）\n'));
}
