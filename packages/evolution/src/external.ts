/**
 * @hmharness/evolution - External Task Injection (P0-06)
 *
 * The audit's anti-self-validation requirement: "如果 Agent 自己生成任务、
 * 自己执行、自己评测，就很容易得到自证式 improvement"
 *
 * This module provides:
 * 1. External task intake: real user/external project tasks enter the system
 * 2. Holdout marking: external tasks go to a SEPARATE holdout set
 * 3. Contamination prevention: external holdout tasks NEVER enter training
 * 4. Independence verification: holdout results are measured separately
 */

import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface ExternalTask {
  /** unique id */
  id: string;
  /** the task prompt (from a real user, not self-generated) */
  prompt: string;
  /** source identifier (e.g. "github-issue", "user-request", "external-benchmark") */
  source: string;
  /** when this task was submitted */
  submittedAt: string;
  /** expected outcome (if known) for verification */
  expectedOutcome?: string;
  /** the agent's actual result (filled after execution) */
  actualResult?: string;
  /** whether this task passed */
  passed?: boolean;
  /** metadata */
  metadata?: Record<string, unknown>;
}

export interface HoldoutReport {
  totalExternal: number;
  totalEvaluated: number;
  passRate: number;
  bySource: Record<string, { total: number; passed: number }>;
  /** contamination check: any external tasks found in training data? */
  contaminationDetected: boolean;
  contaminationCount: number;
}

const externalFile = (home: string) => join(home, 'evolution', 'external-tasks.jsonl');

/**
 * Submit an external task into the system.
 * External tasks are marked separately and NEVER enter the training set.
 */
export async function submitExternalTask(
  home: string,
  task: { prompt: string; source: string; expectedOutcome?: string; metadata?: Record<string, unknown> },
): Promise<ExternalTask> {
  const dir = join(home, 'evolution');
  await mkdir(dir, { recursive: true });
  const ext: ExternalTask = {
    id: `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    prompt: task.prompt,
    source: task.source,
    submittedAt: new Date().toISOString(),
    expectedOutcome: task.expectedOutcome,
    metadata: task.metadata,
  };
  await appendFile(externalFile(home), JSON.stringify(ext) + '\n', 'utf8');
  return ext;
}

/**
 * Read all external tasks.
 */
export async function readExternalTasks(home: string): Promise<ExternalTask[]> {
  try {
    const text = await readFile(externalFile(home), 'utf8');
    return text.split('\n').filter(Boolean).map(l => JSON.parse(l) as ExternalTask);
  } catch { return []; }
}

/**
 * CRITICAL: Check that no external holdout tasks have leaked into
 * the training data (DPO pairs). This is the audit's anti-cheating mechanism.
 *
 * Pure - testable.
 */
export function checkContamination(
  externalTasks: ExternalTask[],
  trainingPairPrompts: string[],
): { contaminated: boolean; count: number; details: string[] } {
  const externalPrompts = new Set(externalTasks.map(t => t.prompt.trim().toLowerCase()));
  const details: string[] = [];
  let count = 0;
  for (const prompt of trainingPairPrompts) {
    const normalized = prompt.trim().toLowerCase();
    // exact match or high overlap (first 100 chars)
    const prefix = normalized.slice(0, 100);
    if (externalPrompts.has(normalized) || [...externalPrompts].some(ep => ep.startsWith(prefix))) {
      count++;
      details.push(`training prompt matches external task: "${prompt.slice(0, 60)}..."`);
    }
  }
  return { contaminated: count > 0, count, details };
}

/**
 * Build a holdout report from external task results.
 * Pure - testable.
 */
export function buildHoldoutReport(tasks: ExternalTask[], contaminationResult: { contaminated: boolean; count: number }): HoldoutReport {
  const evaluated = tasks.filter(t => t.passed !== undefined);
  const passed = evaluated.filter(t => t.passed).length;
  const bySource: Record<string, { total: number; passed: number }> = {};
  for (const t of evaluated) {
    const src = t.source || 'unknown';
    if (!bySource[src]) bySource[src] = { total: 0, passed: 0 };
    bySource[src].total++;
    if (t.passed) bySource[src].passed++;
  }
  return {
    totalExternal: tasks.length,
    totalEvaluated: evaluated.length,
    passRate: evaluated.length > 0 ? passed / evaluated.length : 0,
    bySource,
    contaminationDetected: contaminationResult.contaminated,
    contaminationCount: contaminationResult.count,
  };
}

/**
 * Generate a summary of external task status.
 * Pure - testable.
 */
export function externalTaskSummary(tasks: ExternalTask[]): string {
  const pending = tasks.filter(t => t.passed === undefined).length;
  const evaluated = tasks.filter(t => t.passed !== undefined).length;
  const passed = tasks.filter(t => t.passed === true).length;
  const sources = [...new Set(tasks.map(t => t.source))];
  return `external tasks: ${tasks.length} total, ${pending} pending, ${evaluated} evaluated (${passed} passed), sources: ${sources.join(', ') || 'none'}`;
}
