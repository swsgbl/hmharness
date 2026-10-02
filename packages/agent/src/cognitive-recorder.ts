/**
 * @hmharness/agent - cognitive run recorder (blueprint CL-001 / MEM-002)
 *
 * Bridges the LIVE agent loop into the Cognitive OS: every tool call becomes
 * a cognitive trajectory step (action type = tool name, reason = the loop's
 * own event context), and at task end the trajectory lands in the episodic
 * store (HMH_HOME/cognitive/trajectories/) PLUS an episodic memory index
 * entry with full provenance (source/provenance/confidence/timestamp/
 * environment/session — MEM-007). Everything here is best-effort: cognitive
 * recording must never break a task run.
 */
import { TrajectoryStore, TrajectoryRecorder, CognitiveMemory, loadTrajectories, type Action } from '@hmharness/cognitive';

interface OpenCall {
  action: Action;
  startedAt: number;
  prediction?: { claim: string; confidence: number };
}

export class CognitiveRunRecorder {
  private rec: TrajectoryRecorder;
  private store: TrajectoryStore;
  private open = new Map<string, OpenCall>();
  private seq = 0;
  private failures = 0;
  private successes = 0;
  /** per-action-type success EMA seeded from history — lets EVERY regular
   *  task step carry a prediction, feeding the calibration dimension (the
   *  §26-proven value) from 115/3043 steps toward full coverage */
  private beliefs = new Map<string, { rate: number; n: number }>();

  constructor(
    private home: string,
    task: string,
    sessionId: string,
    private cwd: string,
  ) {
    this.store = new TrajectoryStore(home);
    this.rec = new TrajectoryRecorder(`trj-${sessionId}-${Date.now().toString(36)}`, sessionId, { id: 'terminal', version: '1.0.0' }, { id: `goal-${sessionId}`, description: task });
    // seed beliefs from recent history (best-effort, never blocks a task)
    void this.seedBeliefs().catch(() => undefined);
  }

  private async seedBeliefs(): Promise<void> {
    const trajectories = await loadTrajectories(this.home, 200);
    const table = new Map<string, { sum: number; n: number }>();
    for (const traj of trajectories) {
      for (const s of traj.steps) {
        const t = s.action.type;
        const agg = table.get(t) ?? { sum: 0, n: 0 };
        agg.sum += s.outcome === 'success' ? 1 : 0;
        agg.n += 1;
        table.set(t, agg);
      }
    }
    for (const [t, v] of table) this.beliefs.set(t, { rate: v.sum / v.n, n: v.n });
  }

  private predict(type: string): { claim: string; confidence: number } | undefined {
    const b = this.beliefs.get(type);
    if (!b) return undefined; // unseen tool: no prediction beats a fake one
    return { claim: `${type} succeeds ~${Math.round(b.rate * 100)}% (n=${b.n})`, confidence: Number(b.rate.toFixed(3)) };
  }

  private learn(type: string, success: boolean): void {
    const b = this.beliefs.get(type) ?? { rate: success ? 1 : 0, n: 0 };
    b.rate = (b.rate * b.n + (success ? 1 : 0)) / (b.n + 1);
    b.n += 1;
    this.beliefs.set(type, b);
  }

  /** loop onToolCall: open a step for this tool invocation */
  call(toolName: string, args: Record<string, unknown>): void {
    const key = `${toolName}#${++this.seq}`;
    this.open.set(key, {
      action: { id: key, type: toolName, args: clip(args), reason: 'agent loop tool call' },
      startedAt: Date.now(),
      prediction: this.predict(toolName),
    });
  }

  /** loop onToolResult: close the matching step (same tool, FIFO) */
  result(toolName: string, _output: string, isError: boolean): void {
    for (const [key, open] of this.open) {
      if (!key.startsWith(`${toolName}#`)) continue;
      this.open.delete(key);
      const success = !isError;
      if (isError) this.failures += 1; else this.successes += 1;
      this.learn(toolName, success);
      this.rec.record({
        action: open.action,
        outcome: isError ? 'failure' : 'success',
        evidence: [],
        prediction: open.prediction,
        durationMs: Date.now() - open.startedAt,
      });
      return;
    }
    // result without a matching open call (e.g. preflight rejection): still
    // record it so denials are visible in the trajectory
    this.rec.record({
      action: { id: `${toolName}#${++this.seq}`, type: toolName, args: {}, reason: 'tool result without recorded call' },
      outcome: isError ? 'failure' : 'success',
      evidence: [],
      prediction: this.predict(toolName),
    });
  }

  /** task end: persist trajectory + episodic memory index entry */
  async finish(success: boolean, meta: { turns: number; toolUses: number; task: string }): Promise<{ trajectoryId: string } | null> {
    try {
      const traj = this.rec.finish(success);
      // recovery heuristic: a success step that follows a failure step was
      // already counted by TrajectoryRecorder; metrics carry it
      const written = await this.store.append(traj);
      if (!written.ok) return null;
      const mem = new CognitiveMemory(this.home);
      await mem.load();
      await mem.write({
        layer: 'episodic',
        content: `${success ? 'OK' : 'FAIL'} ${meta.toolUses} tools/${meta.turns} turns: ${meta.task.slice(0, 120)}`,
        payload: { trajectoryId: traj.id, tools: meta.toolUses, turns: meta.turns, successes: this.successes, failures: this.failures },
        source: 'agent-run',
        provenance: `trajectory:${traj.id}`,
        confidence: success ? 0.9 : 0.6,
        environment: 'terminal',
        session: traj.sessionId,
        tags: ['run', success ? 'ok' : 'fail'],
      });
      return { trajectoryId: traj.id };
    } catch {
      return null; // cognitive recording is best-effort, never fatal
    }
  }
}

function clip(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {}).slice(0, 12)) {
    out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  return out;
}
