/**
 * @hmharness/agent - browser-extension → Code World Model runtime sensor
 *
 * The audit ontology's RuntimeFact ("runs" sensor) gets its first source:
 * the user's REAL browser. Every extension_page_read observation lands as
 * runtime facts — where the agent looked and what the user had selected.
 * Like the LSP sensor (code-wm-sensor.ts, round 35), this adapter lives
 * in agent — the composition layer that already depends on BOTH
 * @hmharness/extension and @hmharness/cognitive — so neither layering
 * direction is violated, and the mapping is a library call waiting for
 * the model's persistence wiring (same honest posture as round 35).
 *
 * Mapping discipline (honest, bounded):
 *   every page read   → ONE RuntimeFact kind 'ext.page.read'
 *                       (title — url, capped; the identity is the URL)
 *   non-empty selection → ONE kind 'ext.page.selection' (user-intent
 *                       signal — the human highlighted this text while
 *                       the agent was working)
 *   nothing else      → headings/links/text are CONTEXT for the loop's
 *                       turn, not durable facts; flooding the model with
 *                       per-heading facts would be noise dressed as
 *                       evidence.
 */
import { CodeWorldModel, type RuntimeFact } from '@hmharness/cognitive';
import type { RawPageData } from '@hmharness/extension';

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
};

/** Page observation → audit RuntimeFacts (pure; no DOM, no I/O). */
export function pageReadToRuntimeFacts(raw: RawPageData, at = new Date().toISOString()): RuntimeFact[] {
  const title = clip(raw.title, 120);
  const url = clip(raw.url, 300);
  const facts: RuntimeFact[] = [{ kind: 'ext.page.read', detail: title ? `${title} — ${url}` : url, at }];
  const selection = clip(raw.selection, 200);
  if (selection) facts.push({ kind: 'ext.page.selection', detail: selection, at });
  return facts;
}

export interface RuntimeSyncResult {
  factsIngested: number;
}

/** One sensor sync: extension page observation → runtime facts. */
export function syncExtensionRuntime(cwm: CodeWorldModel, raw: RawPageData): RuntimeSyncResult {
  const facts = pageReadToRuntimeFacts(raw);
  for (const f of facts) cwm.ingest({ runtime: f });
  return { factsIngested: facts.length };
}
