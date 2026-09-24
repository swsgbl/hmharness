/**
 * @hmharness/kernel - shadow model router (V2 M10)
 * Blueprint: Task Features → Router → Model → Evaluation → Routing Outcome.
 * Phase 1 (this): pure feature extraction + a decision function that SUGGESTS
 * a route without changing the live static routing - every run logs a
 * routing.outcome row so the suggestion can be scored against reality before
 * it is ever allowed to steer traffic (M9 discipline: shadow first, gate the
 * switch). See ADR-0004.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TaskFeatures {
  /** 0..1 heuristic: length, multi-step verbs, tool-ish nouns */
  complexity: number;
  /** rough script/language signal in the task text */
  language: 'cangjie' | 'arkts' | 'json' | 'shell' | 'other';
  /** domain classification */
  domain: 'harmony' | 'generic';
  /** estimated context need (chars of likely file/lookup work) */
  expectedContext: 'small' | 'medium' | 'large';
  /** free-form budgets the caller may pin (defaults = unconstrained) */
  latencyBudget?: 'low' | 'normal';
  costBudget?: 'low' | 'normal';
}

const STEP_VERBS = /(实现|构建|scaffold|build|修复|repair|排查|diagnose|重构|refactor|迁移|migrate|部署|deploy|测试|test|发布|release)/i;
const MULTI_STEP = /(然后|再|接着|之后|then|after that|step \d|第[一二三1-9]步|&&)/gi;
const HARMONY = /(harmony|鸿蒙|arkts|cangjie|仓颉|hdc|hvigor|ohpm|hap|module\.json5|ability|ets\b)/i;
const CANGJIE = /(cangjie|仓颉|\.cj\b)/i;
const ARKTS = /(arkts|\.ets\b)/i;
const JSONISH = /(\.json5?|manifest|配置文件|schema)/i;
const SHELLY = /(命令行|shell|cmd|powershell|脚本|terminal)/i;

export function extractFeatures(task: string): TaskFeatures {
  const len = task.length;
  const steps = (task.match(MULTI_STEP) ?? []).length;
  const verb = STEP_VERBS.test(task) ? 1 : 0;
  const complexity = Math.max(0, Math.min(1,
    len / 600 * 0.4 + steps / 3 * 0.3 + verb * 0.3,
  ));
  const language: TaskFeatures['language'] = CANGJIE.test(task) ? 'cangjie'
    : ARKTS.test(task) ? 'arkts'
      : JSONISH.test(task) ? 'json'
        : SHELLY.test(task) ? 'shell' : 'other';
  const domain: TaskFeatures['domain'] = HARMONY.test(task) ? 'harmony' : 'generic';
  const expectedContext: TaskFeatures['expectedContext'] = complexity > 0.6 ? 'large' : complexity > 0.3 ? 'medium' : 'small';
  return { complexity: Math.round(complexity * 100) / 100, language, domain, expectedContext };
}

export interface RouteSuggestion {
  /** the route the config actually uses today (recorded for comparison) */
  actual: string;
  /** what the shadow router would pick, and why */
  suggested: string;
  reason: string;
  features: TaskFeatures;
}

/** Pure suggestion: harmony-domain heavy tasks want the domain-tuned route;
 *  huge-context tasks want the long-window model; everything else keeps the
 *  configured default. The caller supplies the route universe. */
export function routeDecision(
  features: TaskFeatures,
  opts: { actual: string; harmonyRoute?: string; heavyRoute?: string; defaultRoute?: string },
): RouteSuggestion {
  if (features.domain === 'harmony' && opts.harmonyRoute && opts.harmonyRoute !== opts.actual) {
    return { actual: opts.actual, features, suggested: opts.harmonyRoute, reason: `harmony-domain task (complexity ${features.complexity})` };
  }
  if (features.expectedContext === 'large' && opts.heavyRoute && opts.heavyRoute !== opts.actual) {
    return { actual: opts.actual, features, suggested: opts.heavyRoute, reason: `large expected context (${features.complexity})` };
  }
  return { actual: opts.actual, features, suggested: opts.actual, reason: 'default route fits' };
}

/** One routing.outcome row (append-only, redaction is the caller's duty). */
export interface RoutingOutcome {
  time: string;
  runId?: string;
  task: string;
  features: TaskFeatures;
  actual: string;
  suggested: string;
  reason: string;
  /** filled after the run: did the actual route succeed? */
  outcome?: string;
  tokens?: number;
}

export async function recordRoutingOutcome(home: string, row: RoutingOutcome): Promise<void> {
  const dir = join(home, 'evolution');
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'routing.jsonl'), JSON.stringify(row) + '\n', 'utf8');
}

export interface RoutingStats {
  total: number;
  agreed: number;
  disagreementRate: number;
  byReason: Record<string, number>;
  /** crude lift proxy: success rate of runs where shadow agreed vs disagreed */
  successAgree: number | null;
  successDisagree: number | null;
}

export async function routingStats(home: string): Promise<RoutingStats> {
  let text = '';
  try { text = await readFile(join(home, 'evolution', 'routing.jsonl'), 'utf8'); } catch { return { total: 0, agreed: 0, disagreementRate: 0, byReason: {}, successAgree: null, successDisagree: null }; }
  const rows = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as RoutingOutcome; } catch { return null; } }).filter(Boolean) as RoutingOutcome[];
  const byReason: Record<string, number> = {};
  let agreed = 0;
  let agreeOk = 0, agreeN = 0, disOk = 0, disN = 0;
  for (const r of rows) {
    const same = r.actual === r.suggested;
    if (same) agreed++;
    byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
    if (r.outcome) {
      if (same) { agreeN++; if (r.outcome === 'ok') agreeOk++; }
      else { disN++; if (r.outcome === 'ok') disOk++; }
    }
  }
  return {
    total: rows.length,
    agreed,
    disagreementRate: rows.length ? Math.round((rows.length - agreed) / rows.length * 100) / 100 : 0,
    byReason,
    successAgree: agreeN >= 8 ? agreeOk / agreeN : null,
    successDisagree: disN >= 8 ? disOk / disN : null,
  };
}
