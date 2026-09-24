/**
 * @hmharness/evaluation - concrete evaluators (hard evidence first).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Evaluator, Evidence, EvaluationResult } from './types.ts';
import { scoreFromEvidence } from './types.ts';

const execCb = promisify(execFile);

/* ---------------- text assertion evaluators (static evidence) ---------------- */

export interface TextAssertionInput {
  output: string;
  /** ALL substrings must appear (case-insensitive). */
  expect?: string[];
  /** Output must equal this (trimmed). */
  expectExact?: string;
  /** Output must match this regex. */
  expectRegex?: string;
  /** NONE of these may appear. */
  expectNone?: string[];
  /** At least ONE must appear. */
  expectAny?: string[];
}

function textEvidence(input: TextAssertionInput): { evidence: Evidence[]; failures: { reason: string }[] } {
  const evidence: Evidence[] = [];
  const failures: { reason: string }[] = [];
  const out = input.output ?? '';
  const lower = out.toLowerCase();
  if (input.expectExact !== undefined) {
    const ok = out.trim() === input.expectExact.trim();
    evidence.push({ kind: 'static', detail: `exact match ${ok ? 'hit' : 'miss'}`, passed: ok });
    if (!ok) failures.push({ reason: `exact mismatch: got "${out.trim().slice(0, 80)}"` });
  }
  if (input.expectRegex) {
    let ok = false;
    try { ok = new RegExp(input.expectRegex).test(out); } catch { failures.push({ reason: `invalid expectRegex: ${input.expectRegex.slice(0, 60)}` }); }
    evidence.push({ kind: 'static', detail: `regex ${ok ? 'matched' : 'no match'}`, passed: ok });
    if (!ok) failures.push({ reason: `regex did not match: ${input.expectRegex.slice(0, 60)}` });
  }
  if (input.expect?.length) {
    const missing = input.expect.filter((e) => !lower.includes(e.toLowerCase()));
    evidence.push({ kind: 'static', detail: `all-substrings ${input.expect.length - missing.length}/${input.expect.length}`, passed: missing.length === 0 });
    if (missing.length) failures.push({ reason: `missing substrings: ${missing.join(' && ').slice(0, 120)}` });
  }
  if (input.expectNone?.length) {
    const leaked = input.expectNone.filter((e) => lower.includes(e.toLowerCase()));
    evidence.push({ kind: 'static', detail: `forbidden-substrings clean: ${leaked.length === 0}`, passed: leaked.length === 0 });
    if (leaked.length) failures.push({ reason: `forbidden substrings present: ${leaked.join(' && ').slice(0, 120)}` });
  }
  if (input.expectAny?.length) {
    const hit = input.expectAny.find((e) => lower.includes(e.toLowerCase()));
    evidence.push({ kind: 'static', detail: `any-substring ${hit ? `hit: ${hit.slice(0, 40)}` : 'none'}`, passed: Boolean(hit) });
    if (!hit) failures.push({ reason: `none of the any-of substrings appeared` });
  }
  return { evidence, failures };
}

export const textAssertionEvaluator: Evaluator<TextAssertionInput> = {
  id: 'text-assertion',
  version: '1.0.0',
  evidenceKind: 'static',
  description: 'Structured text assertions: exact / regex / all-substrings / forbidden / any-of (the bench gate semantics, as an Evaluator).',
  async evaluate(input) {
    const t0 = Date.now();
    const { evidence, failures } = textEvidence(input);
    const { score, passed } = scoreFromEvidence(evidence, failures);
    return { score, passed, evidence, failures, evaluatorId: this.id, evaluatorVersion: this.version, durationMs: Date.now() - t0 };
  },
};

/* ---------------- command executor evaluator (build/tests evidence) ---------------- */

export interface CommandInput {
  /** Executable to run (NO shell string - argv array style only, per shellgate doctrine). */
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  /** Substrings expected in stdout when the command is considered successful. */
  expectOut?: string[];
  /** Forbid these in stdout+stderr (failure markers). */
  forbidOut?: string[];
}

export const commandEvaluator: Evaluator<CommandInput> = {
  id: 'command-exit',
  version: '1.0.0',
  evidenceKind: 'build',
  description: 'Run a command (execFile, no shell) and treat exit code + output as hard evidence - the build/test tier of the ladder.',
  async evaluate(input) {
    const t0 = Date.now();
    const evidence: Evidence[] = [];
    const failures: { reason: string }[] = [];
    try {
      const r = await execCb(input.command, input.args ?? [], { cwd: input.cwd, timeout: input.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      const out = String(r.stdout ?? '') + String(r.stderr ?? '');
      evidence.push({ kind: 'build', detail: `exit 0 in ${Date.now() - t0}ms; output head: ${out.replace(/\s+/g, ' ').slice(0, 120)}`, passed: true });
      if (input.expectOut?.length) {
        const missing = input.expectOut.filter((e) => !out.toLowerCase().includes(e.toLowerCase()));
        evidence.push({ kind: 'build', detail: `expected output ${input.expectOut.length - missing.length}/${input.expectOut.length}`, passed: missing.length === 0 });
        if (missing.length) failures.push({ reason: `expected output missing: ${missing.join(' && ')}` });
      }
      if (input.forbidOut?.length) {
        const leaked = input.forbidOut.filter((e) => out.toLowerCase().includes(e.toLowerCase()));
        evidence.push({ kind: 'build', detail: `forbidden markers clean: ${leaked.length === 0}`, passed: leaked.length === 0 });
        if (leaked.length) failures.push({ reason: `forbidden markers present: ${leaked.join(' && ')}` });
      }
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      const out = String(e.stdout ?? '') + String(e.stderr ?? '');
      evidence.push({ kind: 'build', detail: `exit ${e.code ?? '?'}${e.killed ? ' (timed out)' : ''}; output head: ${out.replace(/\s+/g, ' ').slice(0, 120)}`, passed: false });
      failures.push({ reason: `command failed with exit ${e.code ?? '?'}: ${out.replace(/\s+/g, ' ').slice(0, 140)}` });
    }
    const { score, passed } = scoreFromEvidence(evidence, failures);
    return { score, passed, evidence, failures, evaluatorId: this.id, evaluatorVersion: this.version, durationMs: Date.now() - t0 };
  },
};

/* ---------------- LLM judge (LAST resort, always labeled) ---------------- */

export interface LlmJudgeInput {
  task: string;
  output: string;
  criteria: string[];
  /** Injected provider call - tests substitute; production passes kernel chat(). */
  call: (system: string, user: string) => Promise<string>;
}

export const llmJudgeEvaluator: Evaluator<LlmJudgeInput> = {
  id: 'llm-judge',
  version: '1.0.0',
  evidenceKind: 'llmJudge',
  description: 'LLM judge - LAST resort on the evidence ladder. Its verdict alone can never mark a run fully passed (score hard-capped at 0.7).',
  async evaluate(input) {
    const t0 = Date.now();
    const evidence: Evidence[] = [];
    const failures: { reason: string }[] = [];
    try {
      const verdict = await input.call(
        'You are an independent evaluator. Judge ONLY from the task, the output, and the criteria. Never trust the agent\'s self-assessment. Reply with exactly PASS or FAIL on the first line, then one short reason.',
        `Task: ${input.task.slice(0, 500)}\nCriteria:\n${input.criteria.map((c) => `- ${c}`).join('\n')}\nOutput:\n${input.output.slice(0, 4000)}`,
      );
      const pass = /^\s*PASS\b/i.test(verdict);
      evidence.push({ kind: 'llmJudge', detail: verdict.replace(/\s+/g, ' ').slice(0, 160), passed: pass });
      if (!pass) failures.push({ reason: `judge: ${verdict.replace(/\s+/g, ' ').slice(0, 140)}` });
    } catch (err) {
      failures.push({ reason: `judge call failed: ${String(err).slice(0, 120)}` });
      evidence.push({ kind: 'llmJudge', detail: 'judge unavailable', passed: false });
    }
    const { score, passed } = scoreFromEvidence(evidence, failures);
    // judge-only pass is capped by scoreFromEvidence (0.7) and can still be
    // 'passed' for advisory purposes; promotion gates must combine with harder evidence
    return { score, passed, evidence, failures, evaluatorId: this.id, evaluatorVersion: this.version, durationMs: Date.now() - t0 };
  },
};

export const allEvaluators: Evaluator<never>[] = [textAssertionEvaluator, commandEvaluator, llmJudgeEvaluator] as unknown as Evaluator<never>[];
