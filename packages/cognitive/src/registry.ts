/**
 * @hmharness/cognitive - environment registry (ENV-005/007/008/010)
 *
 * Environments register themselves; the registry is the single lookup point
 * for goal planning, exploration and the benchmark harness. It also owns:
 *  - health()        : probe observe() under a timeout (ENV-007)
 *  - versioning      : one id may hold multiple versions (ENV-008)
 *  - conformance()   : the SAME contract test for every environment, so an
 *                      adapter cannot quietly degrade into a fake (ENV-010)
 */
import type { Capability, Environment, Observation, ActionResult, EnvironmentScore } from './protocol.ts';
import { validateObservation, stableHash } from './protocol.ts';

export interface RegisteredEnvironment {
  env: Environment;
  registeredAt: string;
  lastHealth?: { ok: boolean; checkedAt: string; detail?: string };
}

export class EnvironmentRegistry {
  private byId = new Map<string, RegisteredEnvironment>();
  private byIdVersion = new Map<string, Environment>();

  register(env: Environment, opts?: { replace?: boolean }): void {
    const key = `${env.id}@${env.version}`;
    if (this.byId.has(env.id) && !opts?.replace && this.byId.get(env.id)!.env.version !== env.version) {
      // same id, different version: keep both, newest becomes default
    } else if (this.byId.has(env.id) && !opts?.replace) {
      throw new Error(`environment ${env.id}@${env.version} already registered`);
    }
    this.byId.set(env.id, { env, registeredAt: new Date().toISOString() });
    this.byIdVersion.set(key, env);
  }

  list(): Array<{ id: string; version: string; registeredAt: string; lastHealth?: RegisteredEnvironment['lastHealth'] }> {
    return [...this.byId.values()].map((r) => ({
      id: r.env.id,
      version: r.env.version,
      registeredAt: r.registeredAt,
      lastHealth: r.lastHealth,
    }));
  }

  get(id: string): Environment | undefined {
    return this.byId.get(id)?.env;
  }

  getVersion(id: string, version: string): Environment | undefined {
    return this.byIdVersion.get(`${id}@${version}`);
  }

  /** ENV-007: observe() must answer within timeoutMs. */
  async health(id: string, timeoutMs = 5_000): Promise<{ ok: boolean; checkedAt: string; detail?: string }> {
    const entry = this.byId.get(id);
    if (!entry) return { ok: false, checkedAt: new Date().toISOString(), detail: 'not registered' };
    try {
      const obs = await withTimeout(entry.env.observe(), timeoutMs, `health timeout after ${timeoutMs}ms`);
      const v = validateObservation(obs);
      entry.lastHealth = {
        ok: v.valid,
        checkedAt: new Date().toISOString(),
        detail: v.valid ? undefined : v.errors.join('; '),
      };
    } catch (err) {
      entry.lastHealth = {
        ok: false,
        checkedAt: new Date().toISOString(),
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    return entry.lastHealth;
  }

  /** ENV-010: the shared contract test. Every environment must pass it.
   *  Exercises the full protocol surface on a throwaway reset. */
  async conformance(env: Environment, timeoutMs = 15_000): Promise<{ pass: boolean; failures: string[] }> {
    const failures: string[] = [];
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await withTimeout(fn(), timeoutMs, `${name} timed out`);
      } catch (err) {
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await step('capabilities', async () => {
      const caps = await env.capabilities();
      if (!Array.isArray(caps) || caps.length === 0) throw new Error('no capabilities declared');
    });
    let obs: Observation | undefined;
    await step('reset', async () => {
      obs = await env.reset({});
      const v = validateObservation(obs);
      if (!v.valid) throw new Error(v.errors.join('; '));
    });
    await step('observe', async () => {
      const o = await env.observe();
      const v = validateObservation(o);
      if (!v.valid) throw new Error(v.errors.join('; '));
      if (o.environmentId !== env.id) throw new Error(`environmentId mismatch: ${o.environmentId}`);
    });
    await step('act(noop)', async () => {
      const noop = obs?.availableActions.find((a) => (a.cost ?? 0) === 0) ?? obs?.availableActions[0];
      if (!noop) throw new Error('no available action to probe');
      const r: ActionResult = await env.act({ id: `conformance-${noop.id}`, type: noop.type, args: {}, reason: 'conformance probe' });
      if (!['success', 'failure', 'unknown'].includes(r.outcome)) throw new Error('invalid outcome');
      if (r.outcome === 'failure' && !r.error) throw new Error('failure without structured error');
    });
    await step('snapshot+restore', async () => {
      const snap = await env.snapshot();
      if (typeof snap.stateHash !== 'string' || !snap.stateHash) throw new Error('snapshot.stateHash required');
      await env.restore(snap);
      const after = await env.snapshot();
      if (after.stateHash !== stableHash(snap.payload) && after.stateHash !== snap.stateHash) {
        // hash drift after immediate restore means restore is not faithful
        failures.push('snapshot/restore: stateHash diverged right after restore');
      }
    });
    await step('evaluate', async () => {
      const score: EnvironmentScore = await env.evaluate();
      if (typeof score.metrics !== 'object' || score.metrics === null) throw new Error('evaluate must return metrics object');
    });
    await step('close', async () => {
      await env.close();
    });
    return { pass: failures.length === 0, failures };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** A minimal in-memory environment used by tests and as the reference
 *  implementation of the protocol (deterministic, replayable). */
export class MemoryEnvironment implements Environment {
  id: string;
  version = '1.0.0';
  private state: Record<string, unknown> = {};
  private stepCount = 0;

  constructor(id = 'memory') {
    this.id = id;
  }

  async capabilities(): Promise<Capability[]> {
    return [
      { kind: 'observe', detail: 'key-value state' },
      { kind: 'act', detail: 'set/delete keys' },
      { kind: 'snapshot', detail: 'full state clone' },
    ];
  }

  async reset(): Promise<Observation> {
    this.state = {};
    this.stepCount = 0;
    return this.observe();
  }

  async observe(): Promise<Observation> {
    return {
      environmentId: this.id,
      timestamp: new Date().toISOString(),
      state: { ...this.state, stepCount: this.stepCount },
      availableActions: [
        { id: 'set', type: 'set', description: 'set a key', argsSchema: { key: 'string', value: 'unknown' }, cost: 1 },
        { id: 'delete', type: 'delete', description: 'delete a key', argsSchema: { key: 'string' }, cost: 1, irreversible: true },
      ],
    };
  }

  async act(action: { type: string; args: Record<string, unknown> }): Promise<ActionResult> {
    this.stepCount += 1;
    const started = Date.now();
    if (action.type === 'set') {
      const { key, value } = action.args;
      if (typeof key !== 'string') {
        return { actionId: 'anon', outcome: 'failure', error: { code: 'E_ARGS', message: 'key must be a string' }, durationMs: Date.now() - started };
      }
      this.state[key] = value ?? null;
      return { actionId: 'anon', outcome: 'success', durationMs: Date.now() - started };
    }
    if (action.type === 'delete') {
      const { key } = action.args;
      if (typeof key !== 'string') {
        return { actionId: 'anon', outcome: 'failure', error: { code: 'E_ARGS', message: 'key must be a string' }, durationMs: Date.now() - started };
      }
      delete this.state[key];
      return { actionId: 'anon', outcome: 'success', durationMs: Date.now() - started };
    }
    return { actionId: 'anon', outcome: 'failure', error: { code: 'E_UNKNOWN_ACTION', message: `unknown action type ${action.type}` }, durationMs: Date.now() - started };
  }

  async snapshot() {
    return {
      environmentId: this.id,
      version: 1,
      takenAt: new Date().toISOString(),
      stateHash: stableHash(this.state),
      payload: JSON.parse(JSON.stringify(this.state)),
    };
  }

  async restore(snapshot: { payload: unknown }): Promise<void> {
    this.state = JSON.parse(JSON.stringify(snapshot.payload)) as Record<string, unknown>;
  }

  async evaluate(): Promise<EnvironmentScore> {
    return { environmentId: this.id, metrics: { keys: Object.keys(this.state).length, steps: this.stepCount } };
  }

  async close(): Promise<void> {
    this.state = {};
  }
}
