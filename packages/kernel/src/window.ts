/**
 * @hmharness/kernel - window (model-aware context engineering, part 1)
 * The context budget used to be one fixed char number for every model - a
 * 128K-window flash model and a 1M-window model got the same 160K chars
 * (small windows overflow, huge windows waste). This registry maps model
 * names to their context windows; budgets then scale with the window.
 *
 * Layered resolution (first hit wins):
 *   1. ProviderConfig.contextWindow (explicit, tokens) - the user is right
 *   2. registry pattern match on the model name - conservative values
 *   3. unknown -> null (callers fall back to the legacy fixed default)
 *
 * Registry values are deliberately CONSERVATIVE (never the vendor max):
 * a wrong-low budget costs a bit of context; a wrong-high one costs the run.
 */
export interface ContextWindowInfo {
  windowTokens: number | null;
  source: 'config' | 'registry' | 'unknown';
}

/** Ordered [pattern, conservative window tokens]. First match wins. */
const REGISTRY: Array<[RegExp, number]> = [
  [/claude/i, 200_000],
  [/gpt-4\.1/i, 1_000_000],
  [/gpt-5/i, 400_000],
  [/gpt-4o/i, 128_000],
  [/\bo[34](-mini)?\b/i, 200_000],
  [/gemini/i, 1_000_000],
  [/glm-\d/i, 131_072],
  [/deepseek/i, 128_000],
  [/kimi/i, 131_072],
  [/qwen/i, 131_072],
  [/llama/i, 128_000],
  [/doubao/i, 128_000],
  [/hunyuan|ernie|minimax|step-/i, 128_000],
];

export function contextWindowFor(p: { model: string; contextWindow?: number }): ContextWindowInfo {
  if (typeof p.contextWindow === 'number' && p.contextWindow > 0) {
    return { windowTokens: p.contextWindow, source: 'config' };
  }
  for (const [re, tokens] of REGISTRY) {
    if (re.test(p.model)) return { windowTokens: tokens, source: 'registry' };
  }
  return { windowTokens: null, source: 'unknown' };
}

/** Transcript char budget for a window: ~2.5 chars/token mixed-language
 *  (ASCII ~4, CJK ~1.2), and only HALF the window may be history - the rest
 *  belongs to system prompt, injected memory/skills, tool schemas and the
 *  reply. 128K tokens -> 160K chars, which is exactly the legacy default -
 *  known-window models scale from there, unknown models keep today's
 *  behaviour unchanged. */
export const CHARS_PER_TOKEN = 2.5;
export const HISTORY_WINDOW_FRACTION = 0.5;
export const MIN_CONTEXT_CHARS = 40_000;
export const MAX_CONTEXT_CHARS = 1_000_000;
export const LEGACY_DEFAULT_CONTEXT_CHARS = 160_000;

export function contextBudgetChars(windowTokens: number | null): number {
  if (windowTokens === null) return LEGACY_DEFAULT_CONTEXT_CHARS;
  const raw = windowTokens * CHARS_PER_TOKEN * HISTORY_WINDOW_FRACTION;
  return Math.round(Math.min(MAX_CONTEXT_CHARS, Math.max(MIN_CONTEXT_CHARS, raw)));
}

/** One-call helper: provider -> adaptive transcript char budget. */
export function adaptiveContextChars(p: { model: string; contextWindow?: number }): number {
  return contextBudgetChars(contextWindowFor(p).windowTokens);
}

/** Adaptive turn limit: larger context windows sustain more turns before
 *  quality degrades (the context budget system compacts throughout, so the
 *  real ceiling is how many turns the model can reason over, not raw token
 *  count). Floor 25 (small models), cap 80 (even 1M windows don't need more).
 *  This fixes the "25 turns auto-stop" complaint — the context engineering
 *  was working fine, the turn cap was the bottleneck. */
export function adaptiveMaxTurns(p: { model: string; contextWindow?: number }): number {
  const budget = contextBudgetChars(contextWindowFor(p).windowTokens);
  return Math.max(25, Math.min(80, Math.floor(budget / 4000)));
}
