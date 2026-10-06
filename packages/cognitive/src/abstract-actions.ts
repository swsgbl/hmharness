/**
 * @hmharness/cognitive - abstract action mapping (blueprint §17 / TR-002 core)
 *
 * Cross-environment transfer fails at the LITERAL action layer (terminal's
 * writeFile and harmonyos's hdc-install share no type string). The abstract
 * layer names the INTENT: write / install / run / observe / remove / verify.
 * World-model beliefs replay through this map, so knowledge earned in one
 * environment can inform another — while the map itself stays explicit and
 * auditable (no silent fuzzy matching).
 */
export type AbstractAction = 'observe' | 'read' | 'write' | 'edit' | 'create' | 'run' | 'verify' | 'recover' | 'install' | 'launch' | 'remove' | 'query' | 'navigate' | 'interact';

/** explicit, auditable literal→abstract edges. Extend deliberately. */
export const ABSTRACT_ACTION_MAP: Record<string, AbstractAction> = {
  // terminal environment
  'command': 'run',
  'writeFile': 'write',
  'deleteFile': 'remove',
  // agent tools (trajectory steps use tool names)
  'read_file': 'read',
  'write_file': 'write',
  'edit_file': 'edit',
  'run_command': 'run',
  'list_dir': 'observe',
  'web_fetch': 'query',
  'web_search': 'query',
  'browser_open': 'navigate',
  'desktop_click': 'interact',
  'desktop_type': 'interact',
  'desktop_screenshot': 'observe',
  // harmonyos environment
  'hdc-shell': 'run',
  'hdc-install': 'install',
  'hdc-aa-start': 'launch',
  'harmony_project_create': 'create',
  'harmony_build': 'verify',
  'harmony_device_test': 'verify',
  // browser-extension bridge tools (round 43+: the real-browser surface)
  'extension_page_read': 'read',
  'extension_page_act': 'interact',
  'extension_tabs': 'observe',
  // arc-agi-3 environment (all seven actions are game interactions;
  // ACTION6 is the coordinate variant of the same intent)
  'ACTION1': 'interact', 'ACTION2': 'interact', 'ACTION3': 'interact',
  'ACTION4': 'interact', 'ACTION5': 'interact', 'ACTION6': 'interact',
  'ACTION7': 'interact',
  // 'recover' currently maps NOTHING: recovery today is harness-internal
  // (MEA bounded replan/retry), not a tool literal. The verb exists so a
  // trajectory can express it the day a tool does - absent edges are not
  // fabricated edges.
};

export function abstractOf(actionType: string): AbstractAction | undefined {
  return ABSTRACT_ACTION_MAP[actionType];
}

/** both sides map to the same abstract intent? */
export function abstractlyOverlaps(a: string, b: string): boolean {
  const aa = abstractOf(a);
  const ab = abstractOf(b);
  return aa !== undefined && aa === ab;
}

/* ---------------- Transfer OS (upgrade pack section 12, P1) ---------------- */

export const TRANSFER_ENVIRONMENTS = ['terminal', 'harmonyos', 'browser', 'desktop', 'arc3'] as const;
export type TransferEnvironmentId = (typeof TRANSFER_ENVIRONMENTS)[number];

/** explicit, auditable literal→environment attribution - the matrix is
 *  only as honest as this table; nothing is inferred heuristically. */
export const LITERAL_ENVIRONMENT: Record<string, TransferEnvironmentId> = {
  'command': 'terminal', 'writeFile': 'terminal', 'deleteFile': 'terminal',
  'read_file': 'terminal', 'write_file': 'terminal', 'edit_file': 'terminal',
  'run_command': 'terminal', 'list_dir': 'terminal', 'web_fetch': 'terminal', 'web_search': 'terminal',
  'browser_open': 'browser',
  'extension_page_read': 'browser', 'extension_page_act': 'browser', 'extension_tabs': 'browser',
  'desktop_click': 'desktop', 'desktop_type': 'desktop', 'desktop_screenshot': 'desktop',
  'hdc-shell': 'harmonyos', 'hdc-install': 'harmonyos', 'hdc-aa-start': 'harmonyos',
  'harmony_project_create': 'harmonyos', 'harmony_build': 'harmonyos', 'harmony_device_test': 'harmonyos',
  'ACTION1': 'arc3', 'ACTION2': 'arc3', 'ACTION3': 'arc3', 'ACTION4': 'arc3',
  'ACTION5': 'arc3', 'ACTION6': 'arc3', 'ACTION7': 'arc3',
};

/** Derived, never invented: an environment's abstract verbs are the union
 *  of its attributed literals' intents. */
export function environmentAbstractActions(env: TransferEnvironmentId): AbstractAction[] {
  const out = new Set<AbstractAction>();
  for (const [literal, e] of Object.entries(LITERAL_ENVIRONMENT)) {
    if (e !== env) continue;
    const a = ABSTRACT_ACTION_MAP[literal];
    if (a) out.add(a);
  }
  return [...out].sort();
}

export interface TransferMatrixCellEvidence {
  score: number;
  verdict: 'positive' | 'neutral' | 'negative';
  runsPerArm: number;
  calibrationDelta?: number;
}

export interface TransferMatrixCell {
  source: TransferEnvironmentId;
  target: TransferEnvironmentId;
  overlap: AbstractAction[];
  /** |A∩B| / |A∪B| over the two environments' abstract verb sets */
  jaccard: number;
  status: 'same-env' | 'no-overlap' | 'overlap-no-evidence' | 'evidence';
  evidence?: TransferMatrixCellEvidence;
}

/** The 5x5 the pack demands. Honesty rules, machine-encoded:
 *  - overlap is NECESSARY, not sufficient - a pair with verbs in common and
 *    no controlled two-arm experiment reports 'overlap-no-evidence', never
 *    a transfer claim (terminal->browser's honest lesson)
 *  - 'evidence' requires a supplied TransferExperimentReport-shaped record
 *  - the diagonal is 'same-env', not transfer */
export function transferMatrix(
  experiments: Array<Pick<import('./transfer-lab.ts').TransferExperimentReport, 'sourceEnv' | 'targetEnv' | 'score' | 'verdict' | 'runsPerArm' | 'calibrationDelta'>>,
): TransferMatrixCell[][] {
  const envVerbs = new Map(TRANSFER_ENVIRONMENTS.map((e) => [e, new Set(environmentAbstractActions(e))]));
  const expBy = new Map(experiments.map((e) => [`${e.sourceEnv}->${e.targetEnv}`, e]));
  return TRANSFER_ENVIRONMENTS.map((source) =>
    TRANSFER_ENVIRONMENTS.map((target) => {
      if (source === target) return { source, target, overlap: [], jaccard: 1, status: 'same-env' as const };
      const a = envVerbs.get(source)!;
      const b = envVerbs.get(target)!;
      const overlap = [...a].filter((v) => b.has(v)).sort();
      const union = new Set([...a, ...b]);
      const jaccard = union.size ? Number((overlap.length / union.size).toFixed(3)) : 0;
      const exp = expBy.get(`${source}->${target}`);
      if (overlap.length === 0) return { source, target, overlap, jaccard, status: 'no-overlap' as const };
      if (!exp) return { source, target, overlap, jaccard, status: 'overlap-no-evidence' as const };
      return {
        source, target, overlap, jaccard, status: 'evidence' as const,
        evidence: { score: exp.score, verdict: exp.verdict, runsPerArm: exp.runsPerArm, ...(exp.calibrationDelta !== undefined ? { calibrationDelta: exp.calibrationDelta } : {}) },
      };
    }),
  );
}
