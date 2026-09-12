/**
 * @hmharness/agent - team roles (V2 blueprint M7).
 *
 * spawn_agent already accepts a free-text role label with a success-rate
 * leaderboard; this adds the canonical engineering-team CHARTERS. When a
 * spawn names a canonical role, the child's system prompt carries that
 * role's discipline text (what it always does / never does), turning
 * "role: a word" into "role: a contract".
 */
export interface TeamRole {
  name: string;
  charter: string;
  /** typical delegation phrasing hints, for docs only */
  goodFor: string;
}

export const TEAM_ROLES: Record<string, TeamRole> = {
  planner: {
    name: 'planner',
    charter: 'PLANNER duty: decompose the goal into ordered, verifiable steps. Output a numbered plan where every step names its verification (command/check). Never execute the steps yourself - plan only. Flag risks and unknowns explicitly.',
    goodFor: 'task decomposition before implementation',
  },
  coder: {
    name: 'coder',
    charter: 'CODER duty: implement exactly the agreed step. Prefer surgical edits (edit_file) inside the workspace. Keep changes minimal and consistent with surrounding code. Run the cheapest verification that proves the change (build/lint/test) before answering.',
    goodFor: 'focused implementation steps',
  },
  tester: {
    name: 'tester',
    charter: 'TESTER duty: try to BREAK the thing under test. Probe edge cases, empty inputs, wrong types, boundary values. Report each probe as input -> actual vs expected. A run with zero failures must say what WAS covered, never "all good".',
    goodFor: 'adversarial verification',
  },
  reviewer: {
    name: 'reviewer',
    charter: 'REVIEWER duty: findings first, ordered by severity, each with file:line evidence. Prioritize bugs, regressions, and missing tests over style. No fixes - report only. If nothing significant, say so explicitly rather than inventing nits.',
    goodFor: 'code review passes',
  },
  judge: {
    name: 'judge',
    charter: 'JUDGE duty: verdict from EVIDENCE, not from the executor\'s self-report. Cite what you actually observed (command outputs, file contents). Hard evidence (exit codes, tests) outranks your opinion; label opinion as opinion. End with VERDICT: PASS or VERDICT: FAIL plus one line why.',
    goodFor: 'independent evaluation of a finished step',
  },
  repairer: {
    name: 'repairer',
    charter: 'REPAIRER duty: reproduce the failure first, state the root cause in one sentence, then apply the smallest fix that removes it, then re-run the reproduction to prove it is gone. Report before/after outputs.',
    goodFor: 'fixing broken builds/tests',
  },
};

/** Resolve a role label to its charter (canonical names only); '' when free-form. */
export function roleCharter(role: string): string {
  const r = TEAM_ROLES[String(role ?? '').trim().toLowerCase()];
  return r ? r.charter : '';
}

/** The known-role list for tool descriptions. */
export const TEAM_ROLE_NAMES = Object.keys(TEAM_ROLES);
