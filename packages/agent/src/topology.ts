/**
 * @hmharness/agent - Dynamic Agent Topology (P2-03)
 *
 * The audit called for: "根据任务复杂度自动决定单 Agent、双 Agent 或完整 Team"
 *
 * Analyzes task characteristics and decides the optimal agent configuration.
 */

export type TopologyMode = 'single' | 'dual' | 'team' | 'pipeline';

export interface TopologyDecision {
  mode: TopologyMode;
  /** roles to activate */
  roles: string[];
  /** confidence in this decision [0,1] */
  confidence: number;
  /** reasoning for the decision */
  reason: string;
  /** estimated complexity score [0,100] */
  complexity: number;
}

export interface TaskCharacteristics {
  /** word count of the task description */
  wordCount: number;
  /** number of distinct file types mentioned */
  fileTypes: number;
  /** whether the task mentions building/testing/deploying */
  requiresBuild: boolean;
  requiresTest: boolean;
  requiresDeploy: boolean;
  /** whether the task mentions multiple modules/services */
  multiModule: boolean;
  /** estimated number of steps from the task description */
  estimatedSteps: number;
  /** whether the task involves external APIs/services */
  externalDependencies: boolean;
}

/**
 * Compute a complexity score [0,100] from task characteristics.
 * Pure - testable.
 */
export function complexityScore(c: TaskCharacteristics): number {
  let score = 0;
  // word count: longer tasks are generally more complex (up to +20)
  score += Math.min(20, c.wordCount / 5);
  // file types: more types = more complexity (up to +15)
  score += Math.min(15, c.fileTypes * 3);
  // build/test/deploy requirements (+5 each, max +15)
  if (c.requiresBuild) score += 5;
  if (c.requiresTest) score += 5;
  if (c.requiresDeploy) score += 5;
  // multi-module (+10)
  if (c.multiModule) score += 10;
  // estimated steps (up to +25)
  score += Math.min(25, c.estimatedSteps * 3);
  // external deps (+15)
  if (c.externalDependencies) score += 15;
  return Math.min(100, Math.round(score));
}

/**
 * Decide the optimal topology based on complexity.
 * Pure - testable.
 */
export function decideTopology(c: TaskCharacteristics): TopologyDecision {
  const complexity = complexityScore(c);
  if (complexity < 20) {
    return {
      mode: 'single', roles: ['coder'],
      confidence: 0.9,
      reason: `low complexity (${complexity}/100) - single agent sufficient`,
      complexity,
    };
  }
  if (complexity < 45) {
    return {
      mode: 'dual', roles: ['coder', 'reviewer'],
      confidence: 0.8,
      reason: `medium complexity (${complexity}/100) - coder + reviewer pair`,
      complexity,
    };
  }
  if (complexity < 70) {
    return {
      mode: 'pipeline', roles: ['planner', 'coder', 'tester', 'judge'],
      confidence: 0.75,
      reason: `high complexity (${complexity}/100) - pipeline with review gate`,
      complexity,
    };
  }
  return {
    mode: 'team', roles: ['planner', 'architect', 'coder', 'tester', 'reviewer', 'judge'],
    confidence: 0.85,
    reason: `very high complexity (${complexity}/100) - full team with architecture`,
    complexity,
  };
}

/**
 * Extract task characteristics from a natural language task description.
 * Pure - testable.
 */
export function extractCharacteristics(taskDescription: string): TaskCharacteristics {
  const words = taskDescription.split(/\s+/).filter(Boolean);
  const lower = taskDescription.toLowerCase();
  return {
    wordCount: words.length,
    fileTypes: countFileTypes(taskDescription),
    requiresBuild: /build|compile|make|npm run/i.test(taskDescription),
    requiresTest: /test|spec|verify|assert/i.test(taskDescription),
    requiresDeploy: /deploy|install|publish|release/i.test(taskDescription),
    multiModule: /module|service|package|component/i.test(lower) && (lower.match(/module|service|package|component/g) ?? []).length > 1,
    estimatedSteps: countSteps(taskDescription),
    externalDependencies: /api|http|url|fetch|request|external/i.test(lower),
  };
}

function countFileTypes(text: string): number {
  const types = new Set<string>();
  const exts = text.match(/\.\w{1,5}\b/g) ?? [];
  for (const e of exts) types.add(e);
  // also count mentioned languages
  if (/typescript|\.ts\b/i.test(text)) types.add('.ts');
  if (/javascript|\.js\b/i.test(text)) types.add('.js');
  if (/python|\.py\b/i.test(text)) types.add('.py');
  if (/json/i.test(text)) types.add('.json');
  return types.size;
}

function countSteps(text: string): number {
  const stepPatterns = [
    /first.*then/i, /step \d/i, /\d+\./, /after that/i, /next/i, /finally/i,
    /then/i, /create.*write.*test/i, /read.*modify.*verify/i,
  ];
  let count = 1; // at least one step
  for (const p of stepPatterns) {
    if (p.test(text)) count++;
  }
  return Math.min(count, 10);
}
