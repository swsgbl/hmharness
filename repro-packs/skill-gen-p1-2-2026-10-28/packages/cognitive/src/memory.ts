/**
 * @hmharness/cognitive - five-layer memory (blueprint §7 / MEM-001..010)
 *
 * working   : current-task context/drafts, minutes-lived, runtime only
 * episodic  : full trajectories/experiences, written at task end (the
 *             TrajectoryStore is the episodic substrate; this layer indexes
 *             it for retrieval)
 * semantic  : rules/facts/concepts, written ONLY by distill+verify
 * procedural: skills/workflows/policies — versioned, owned by the skill
 *             compiler (this layer stores refs, not bodies)
 * world     : environment state/causal/prediction errors — owned by the
 *             world model (refs again)
 *
 * Blueprint rule (§8 of master prompt): EVERY long-term entry carries
 * source/provenance/confidence/timestamp/environment/session — enforced by
 * validateEntry, not by convention. Contradiction detection (MEM-008) flags
 * same-key claims with divergent values; consolidation (MEM-009) merges
 * duplicates and decays stale entries WITHOUT deleting originals
 * (append-only: contradicted entries get supersededBy, never removed).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stableHash } from './protocol.ts';

export type MemoryLayer = 'working' | 'episodic' | 'semantic' | 'procedural' | 'world';

export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  /** the claim / rule / ref itself */
  content: string;
  /** structured payload (skill ref, trajectory ref, belief snapshot…) */
  payload?: unknown;
  // ---- provenance (mandatory for every long-term entry) ----
  source: string;
  provenance: string;
  confidence: number;
  timestamp: string;
  environment: string;
  session: string;
  /** set when a newer entry superseded this one (append-only evolution) */
  supersededBy?: string;
  tags?: string[];
}

export interface ContradictionReport {
  key: string;
  entries: Array<{ id: string; content: string; confidence: number }>;
}

export class CognitiveMemory {
  private working = new Map<string, MemoryEntry>();
  private longTerm: MemoryEntry[] = [];

  constructor(private home: string) {}

  private file(): string {
    return join(this.home, 'cognitive', 'memory', 'memory.jsonl');
  }

  /* ---- working layer (runtime, not persisted) ---- */

  setWorking(key: string, content: string, session: string): void {
    this.working.set(key, {
      id: `work-${stableHash(key + session).slice(0, 10)}`,
      layer: 'working',
      content,
      source: 'runtime',
      provenance: 'working-memory',
      confidence: 1,
      timestamp: new Date().toISOString(),
      environment: 'runtime',
      session,
    });
  }

  getWorking(key: string): string | undefined {
    return this.working.get(key)?.content;
  }

  clearWorking(): void {
    this.working.clear();
  }

  /* ---- long-term layers ---- */

  async write(entry: Omit<MemoryEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: string }): Promise<MemoryEntry> {
    const full: MemoryEntry = {
      ...entry,
      id: entry.id ?? `mem-${stableHash(entry.content + entry.layer + Date.now()).slice(0, 12)}`,
      timestamp: entry.timestamp ?? new Date().toISOString(),
    };
    const errors = validateEntry(full);
    if (errors.length) throw new Error(`invalid memory entry: ${errors.join('; ')}`);
    this.longTerm.push(full);
    await this.persist();
    return full;
  }

  /** MEM-006 hybrid retrieval (Memory 2.0: scored lexical match): query
   *  terms score individually over content+tags (partial credit, no hard
   *  AND-substring wall — "hvigor build fail" must surface "hvigor 构建失败"
   *  and a note that only mentions build), combined with confidence and
   *  recency. Hard filters stay hard: layer/environment/tags. */
  retrieve(query: { layer?: MemoryLayer; tags?: string[]; text?: string; environment?: string; limit?: number }): MemoryEntry[] {
    let pool = this.longTerm.filter((e) => !e.supersededBy);
    if (query.layer) pool = pool.filter((e) => e.layer === query.layer);
    if (query.environment) pool = pool.filter((e) => e.environment === query.environment);
    if (query.tags?.length) {
      const want = new Set(query.tags);
      pool = pool.filter((e) => (e.tags ?? []).some((t) => want.has(t)));
    }
    const terms = (query.text ?? '').toLowerCase().split(/[\s,，;；]+/).filter((t) => t.length >= 2);
    const lexicalScore = (e: MemoryEntry): number => {
      if (terms.length === 0) return 0;
      const hay = (e.content + ' ' + (e.tags ?? []).join(' ')).toLowerCase();
      let hits = 0;
      for (const t of terms) if (hay.includes(t)) hits += 1;
      return hits / terms.length;
    };
    if (terms.length > 0) pool = pool.filter((e) => lexicalScore(e) > 0);
    const scored = pool.map((e) => ({
      e,
      score: e.confidence * 0.4 + recencyScore(e.timestamp) * 0.2 + lexicalScore(e) * 0.4,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, query.limit ?? 10).map((s) => s.e);
  }

  /** MEM-008. Same subject, divergent claims. */
  detectContradictions(): ContradictionReport[] {
    const active = this.longTerm.filter((e) => !e.supersededBy && e.layer === 'semantic');
    const byKey = new Map<string, MemoryEntry[]>();
    for (const e of active) {
      const key = subjectKey(e.content);
      byKey.set(key, [...(byKey.get(key) ?? []), e]);
    }
    const out: ContradictionReport[] = [];
    for (const [key, entries] of byKey) {
      if (entries.length < 2) continue;
      const normalized = new Set(entries.map((e) => normalizeClaim(e.content)));
      if (normalized.size > 1) {
        out.push({ key, entries: entries.map((e) => ({ id: e.id, content: e.content, confidence: e.confidence })) });
      }
    }
    return out;
  }

  /** MEM-009. Merge duplicates, decay stale entries via supersededBy —
   *  originals stay in the file (append-only, blueprint §10). */
  async consolidate(opts?: { staleDays?: number }): Promise<{ merged: number; decayed: number }> {
    const staleDays = opts?.staleDays ?? 60;
    let merged = 0;
    let decayed = 0;
    const active = this.longTerm.filter((e) => !e.supersededBy && (e.layer === 'semantic' || e.layer === 'episodic'));
    const byKey = new Map<string, MemoryEntry[]>();
    for (const e of active) {
      const key = `${e.layer}:${subjectKey(e.content)}`;
      byKey.set(key, [...(byKey.get(key) ?? []), e]);
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => b.confidence - a.confidence || b.timestamp.localeCompare(a.timestamp));
      const [best, ...rest] = group;
      const sameClaim = rest.filter((r) => normalizeClaim(r.content) === normalizeClaim(best.content));
      for (const r of sameClaim) {
        r.supersededBy = best.id;
        merged += 1;
      }
    }
    const cutoff = Date.now() - staleDays * 86_400_000;
    for (const e of this.longTerm) {
      if (!e.supersededBy && e.layer === 'episodic' && new Date(e.timestamp).getTime() < cutoff && e.confidence < 0.5) {
        e.supersededBy = 'consolidation:stale';
        decayed += 1;
      }
    }
    if (merged || decayed) await this.persist();
    return { merged, decayed };
  }

  async load(): Promise<number> {
    try {
      const text = await readFile(this.file(), 'utf8');
      this.longTerm = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as MemoryEntry);
    } catch {
      this.longTerm = [];
    }
    return this.longTerm.length;
  }

  stats(): Record<MemoryLayer | 'total', number> {
    const out: Record<string, number> = { total: this.longTerm.length };
    for (const l of ['working', 'episodic', 'semantic', 'procedural', 'world'] as MemoryLayer[]) {
      out[l] = this.longTerm.filter((e) => e.layer === l).length;
    }
    return out as Record<MemoryLayer | 'total', number>;
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.home, 'cognitive', 'memory'), { recursive: true });
    await writeFile(this.file(), this.longTerm.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }
}

/** MEM-007 provenance validation: long-term entries without a real source
 *  are rejected at write time. */
export function validateEntry(e: MemoryEntry): string[] {
  const errors: string[] = [];
  if (!e.source) errors.push('source required');
  if (!e.provenance) errors.push('provenance required');
  if (typeof e.confidence !== 'number' || e.confidence < 0 || e.confidence > 1) errors.push('confidence must be in [0,1]');
  if (!e.timestamp) errors.push('timestamp required');
  if (!e.environment) errors.push('environment required');
  if (!e.session) errors.push('session required');
  if (!e.content) errors.push('content required');
  if (e.layer === 'working') errors.push('working entries are runtime-only; do not persist them');
  return errors;
}

function subjectKey(content: string): string {
  // crude subject extraction: the leading subject phrase, lowercased —
  // short (2 tokens) so "X accepts Y" and "X does not accept Y" collide
  // into one subject group for contradiction detection
  return normalizeClaim(content).split(/\s+/).slice(0, 2).join(' ');
}

function normalizeClaim(content: string): string {
  return content.toLowerCase().replace(/[。.!！?？,，、'"]/g, '').replace(/\s+/g, ' ').trim();
}

function recencyScore(timestamp: string): number {
  const age = Date.now() - new Date(timestamp).getTime();
  const days = age / 86_400_000;
  return Math.max(0, 1 - days / 90);
}
