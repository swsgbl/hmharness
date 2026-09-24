/**
 * @hmharness/evolution - context ranker (V2 blueprint M5).
 *
 * Scores retrieval candidates for the context pack. First version uses the
 * blueprint's fixed weights; Evolution is meant to optimize the weights
 * later (that is why they live in one exported constant, not inline math).
 * All inputs are normalized 0..1 by the caller; tokenCost is normalized
 * against the candidate budget by normalize().
 */
export interface ContextCandidate {
  /** where it came from: memory | skill | insight | agents-md | history */
  source: string;
  /** reference (text or id) - ranked, not necessarily injected verbatim */
  contentRef: string;
  relevance: number;
  recency: number;
  importance: number;
  dependency: number;
  similarity: number;
  /** raw token estimate; normalized by the ranker */
  tokenCost: number;
}

export const RANK_WEIGHTS = {
  relevance: 0.30,
  dependency: 0.20,
  recency: 0.15,
  importance: 0.15,
  similarity: 0.10,
  tokenCost: -0.10,
} as const;

const clamp01 = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;

/** Rank candidates: fixed weights, token cost normalized to the batch max,
 *  ties broken by cheaper-first. Returns a NEW sorted array. */
export function rankContext(candidates: ContextCandidate[]): Array<ContextCandidate & { score: number }> {
  const maxCost = Math.max(1, ...candidates.map((c) => c.tokenCost));
  return candidates
    .map((c) => {
      const n = {
        relevance: clamp01(c.relevance),
        dependency: clamp01(c.dependency),
        recency: clamp01(c.recency),
        importance: clamp01(c.importance),
        similarity: clamp01(c.similarity),
        tokenCost: clamp01(c.tokenCost / maxCost),
      };
      const score =
        RANK_WEIGHTS.relevance * n.relevance +
        RANK_WEIGHTS.dependency * n.dependency +
        RANK_WEIGHTS.recency * n.recency +
        RANK_WEIGHTS.importance * n.importance +
        RANK_WEIGHTS.similarity * n.similarity +
        RANK_WEIGHTS.tokenCost * n.tokenCost;
      return { ...c, score: Math.round(score * 1000) / 1000 };
    })
    .sort((a, b) => b.score - a.score || a.tokenCost - b.tokenCost);
}

/** Pick the top-K candidates under a token budget (greedy, ranked order). */
export function packContext(candidates: ContextCandidate[], budgetTokens: number): Array<ContextCandidate & { score: number }> {
  const ranked = rankContext(candidates);
  const out: Array<ContextCandidate & { score: number }> = [];
  let used = 0;
  for (const c of ranked) {
    if (used + c.tokenCost > budgetTokens) continue;
    out.push(c);
    used += c.tokenCost;
  }
  return out;
}

/** The four memory classes (V2 M5). Entries classify by prefix today:
 *  [self-note]/tool lessons -> procedural; (distilled) -> semantic;
 *  session recaps -> episodic; design/decision notes -> project. */
export type MemoryClass = 'episodic' | 'semantic' | 'procedural' | 'project';

export function classifyMemory(entry: string): MemoryClass {
  if (/^\(distilled\)/.test(entry) || /api|sdk|版本|参数/.test(entry.slice(0, 80))) return 'semantic';
  if (/design|架构|决策|why|adr/i.test(entry.slice(0, 80))) return 'project';
  if (/self-note|工具|失败|重试|how to|怎么/.test(entry.slice(0, 80))) return 'procedural';
  return 'episodic';
}
