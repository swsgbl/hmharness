/**
 * @hmharness/cognitive - RLM runtime (blueprint §6 / RLM-001..010)
 *
 * A programmable cognitive workbench: context, memory snippets, environment
 * state, predictions, subagent handles and validators are ADDRESSABLE
 * VARIABLES the (host) program composes. `eval` runs host-supplied code
 * against those variables — the runtime provides isolation walls, resource
 * accounting, checkpoints and forks; it does NOT allow hidden unsafe
 * self-modification: eval code can only touch workspace variables, never
 * the runtime's own governance state (RLM-008).
 */
import { stableHash } from './protocol.ts';

export type RLMValue = unknown;

export interface RLMCheckpoint {
  id: string;
  label?: string;
  createdAt: string;
  stateHash: string;
  snapshot: { vars: Record<string, RLMValue>; log: string[]; budget: ResourceBudget };
}

export interface ResourceBudget {
  maxEvals: number;
  maxWallMs: number;
  maxSubagents: number;
  used: { evals: number; wallMs: number; subagents: number };
}

export interface SubagentSpec {
  role: string;
  task: string;
  budgetMs?: number;
}

export interface AgentHandle {
  id: string;
  role: string;
  /** host-bridged execution: resolves with the subagent's final message */
  completion: Promise<string>;
  cancel(): void;
}

export interface RLMContext {
  vars: Record<string, RLMValue>;
  /** read-only view of governance state (cannot be mutated from eval) */
  readonly meta: { evalsUsed: number; subagentsUsed: number; checkpointCount: number };
}

export interface RLMResult {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
  durationMs: number;
  budget: ResourceBudget;
}

export interface RLMHost {
  /** host bridges subagent execution to the real spawn_agent machinery */
  spawnSubagent(spec: SubagentSpec): Promise<AgentHandle>;
}

export class RLMRuntime {
  private vars: Record<string, RLMValue> = {};
  private log: string[] = [];
  private checkpoints: RLMCheckpoint[] = [];
  private subagents: AgentHandle[] = [];
  private t0 = Date.now();

  constructor(
    private budget: Partial<ResourceBudget> = {},
    private host?: RLMHost,
  ) {}

  get fullBudget(): ResourceBudget {
    return this.materializeBudget();
  }

  private materializeBudget(): ResourceBudget {
    return {
      maxEvals: this.budget.maxEvals ?? 100,
      maxWallMs: this.budget.maxWallMs ?? 10 * 60_000,
      maxSubagents: this.budget.maxSubagents ?? 8,
      used: { evals: this._evals, wallMs: Date.now() - this.t0, subagents: this.subagents.length },
    };
  }

  private _evals = 0;

  /** Addressable variables — the composable context surface (RLM-002). */
  set(name: string, value: RLMValue): void {
    this.assertValidName(name);
    this.vars[name] = value;
    this.log.push(`set ${name}`);
  }

  get(name: string): RLMValue {
    return this.vars[name];
  }

  names(): string[] {
    return Object.keys(this.vars);
  }

  /** RLM-003. Recursive call: eval code can spawn nested evals and read
   *  other variables, but through THIS runtime so accounting holds. */
  async eval(code: string, ctx?: Partial<RLMContext>): Promise<RLMResult> {
    const started = Date.now();
    const budget = this.materializeBudget();
    if (this._evals >= budget.maxEvals) {
      return { ok: false, error: { code: 'E_BUDGET_EVALS', message: `eval budget exhausted (${budget.maxEvals})` }, durationMs: 0, budget };
    }
    if (budget.used.wallMs >= budget.maxWallMs) {
      return { ok: false, error: { code: 'E_BUDGET_WALL', message: `wall-clock budget exhausted (${budget.maxWallMs}ms)` }, durationMs: 0, budget };
    }
    this._evals += 1;
    const meta = Object.freeze({ evalsUsed: this._evals, subagentsUsed: this.subagents.length, checkpointCount: this.checkpoints.length });
    const sandbox: RLMContext = Object.freeze({ vars: this.vars, meta, ...ctx });
    try {
      const fn = new Function('ctx', `"use strict";\n${code}`) as (c: RLMContext) => unknown;
      const value = fn(sandbox);
      const resolved = value instanceof Promise ? await value : value;
      this.log.push(`eval ok (${Date.now() - started}ms)`);
      return { ok: true, value: resolved, durationMs: Date.now() - started, budget: this.materializeBudget() };
    } catch (err) {
      this.log.push(`eval fail: ${String(err).slice(0, 120)}`);
      return {
        ok: false,
        error: { code: 'E_EVAL', message: err instanceof Error ? err.message : String(err) },
        durationMs: Date.now() - started,
        budget: this.materializeBudget(),
      };
    }
  }

  /** RLM-004/005. Checkpoint the whole workspace (vars + log + budget). */
  checkpoint(label?: string): RLMCheckpoint {
    const cp: RLMCheckpoint = {
      id: `cp-${this.checkpoints.length + 1}`,
      label,
      createdAt: new Date().toISOString(),
      stateHash: stableHash({ vars: this.vars, log: this.log }),
      snapshot: {
        vars: JSON.parse(JSON.stringify(this.vars)),
        log: [...this.log],
        budget: JSON.parse(JSON.stringify(this.materializeBudget())),
      },
    };
    this.checkpoints.push(cp);
    return cp;
  }

  restore(cp: RLMCheckpoint): void {
    const existing = this.checkpoints.find((c) => c.id === cp.id) ?? cp;
    this.vars = JSON.parse(JSON.stringify(existing.snapshot.vars));
    this.log = [...existing.snapshot.log, `restored@${existing.id}`];
  }

  /** RLM-003. Fork = independent child workspace from a deep copy. */
  async fork(label?: string): Promise<RLMRuntime> {
    const child = new RLMRuntime(this.budget, this.host);
    child.vars = JSON.parse(JSON.stringify(this.vars));
    child.log = [...this.log, `forked${label ? `(${label})` : ''}`];
    child._evals = this._evals;
    return child;
  }

  /** RLM-007. Subagent lifecycle through the host bridge; counted, cancellable. */
  async spawn(spec: SubagentSpec): Promise<AgentHandle> {
    const budget = this.materializeBudget();
    if (this.subagents.length >= budget.maxSubagents) {
      throw new Error(`subagent budget exhausted (${budget.maxSubagents})`);
    }
    if (!this.host) {
      throw new Error('no RLMHost bridge configured: spawn requires a host that connects to the real agent runtime');
    }
    const handle = await this.host.spawnSubagent(spec);
    this.subagents.push(handle);
    handle.completion.finally(() => {
      this.log.push(`subagent ${handle.id} (${spec.role}) done`);
    }).catch(() => undefined);
    return handle;
  }

  cancelAll(): void {
    for (const a of this.subagents) a.cancel();
    this.subagents = [];
  }

  /** RLM-009. Structured trace of the workspace history. */
  trace(): string[] {
    return [...this.log];
  }

  private assertValidName(name: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid variable name ${name}`);
    }
  }
}
