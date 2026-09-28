/**
 * @hmharness/environments - HarmonyOS environment (ENV-020/021/022)
 *
 * Bridges the Cognitive OS protocol onto hdc (HarmonyOS Device Connector).
 * observe = device list + front app; act = shell/aa start/install (via host
 * hdc); evaluate = app-running + recent hilog error count. Device WRITE
 * actions are marked irreversible — the goal-layer approval gate applies.
 */
import type {
  Environment, Observation, Action, ActionResult, Snapshot, EnvironmentScore,
  Capability, ActionSpec,
} from '@hmharness/cognitive';
import { stableHash } from '@hmharness/cognitive';
import { runShell } from './terminal.ts';

export interface HarmonyOsEnvOptions {
  /** hdc binary; defaults to plain "hdc" from PATH */
  hdc?: string;
  timeoutMs?: number;
}

export class HarmonyOsEnvironment implements Environment {
  id = 'harmonyos';
  version = '1.0.0';
  private readonly hdc: string;
  private readonly timeoutMs: number;
  private lastStates: Array<{ at: string; devices: number; frontApp?: string }> = [];
  /** restore attempts are kept OUT of the observed state — restore() must
   *  never mutate what observe() reports, or snapshot hashes always drift */
  private restoreAttempts: string[] = [];

  constructor(opts: HarmonyOsEnvOptions = {}) {
    this.hdc = opts.hdc ?? 'hdc';
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async capabilities(): Promise<Capability[]> {
    const reachable = await this.hdcOk();
    return [
      { kind: 'observe', detail: 'device list + front application' },
      { kind: 'act', detail: 'hdc shell / aa start / install', limitation: reachable ? undefined : 'hdc not reachable' },
      { kind: 'evaluate', detail: 'front-app check + hilog error count' },
      { kind: 'process', detail: `hdc invocations, ${this.timeoutMs}ms timeout` },
    ];
  }

  async reset(): Promise<Observation> {
    this.lastStates = [];
    return this.observe();
  }

  async observe(): Promise<Observation> {
    const r = await this.hdcRun('list targets');
    const devices = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.includes('[Empty]'));
    let frontApp: string | undefined;
    if (devices.length > 0) {
      const aa = await this.hdcRun('shell aa dump -l').catch(() => ({ code: 1, stdout: '', stderr: '' }));
      const m = aa.stdout.match(/app\s+:\s*\[?([a-zA-Z0-9_.]+)/i);
      frontApp = m?.[1];
    }
    // observe() is READ-ONLY: history records state CHANGES (act/reset),
    // never observations — otherwise every snapshot hash drifts
    return {
      environmentId: this.id,
      timestamp: new Date().toISOString(),
      state: { devices, frontApp, history: this.lastStates.slice(-3) },
      availableActions: this.actionSpecs(devices.length > 0),
    };
  }

  private actionSpecs(ready: boolean): ActionSpec[] {
    const limitation = ready ? undefined : 'no connected device';
    return [
      { id: 'shell', type: 'hdc-shell', description: 'run a shell command on the device', argsSchema: { cmd: 'string' }, cost: 2 },
      { id: 'aa-start', type: 'hdc-aa-start', description: 'start an ability', argsSchema: { bundle: 'string', ability: 'string' }, cost: 3, irreversible: true },
      { id: 'install', type: 'hdc-install', description: 'install a hap on the device', argsSchema: { path: 'string' }, cost: 8, irreversible: true },
    ].map((s) => ({ ...s, description: limitation ? `${s.description} (unavailable: ${limitation})` : s.description }));
  }

  async act(action: Action): Promise<ActionResult> {
    const started = Date.now();
    const probe = await this.hdcRun('list targets');
    const targets = probe.stdout.split(/\r?\n/).filter((l) => l.trim() && !l.includes('[Empty]'));
    this.lastStates.push({ at: new Date().toISOString(), devices: targets.length });
    if (targets.length === 0) {
      return { actionId: action.id, outcome: 'failure', error: { code: 'E_NO_DEVICE', message: 'no HarmonyOS device connected' }, durationMs: Date.now() - started };
    }
    switch (action.type) {
      case 'hdc-shell': {
        const cmd = String(action.args.cmd ?? '');
        if (!cmd.trim()) return { actionId: action.id, outcome: 'failure', error: { code: 'E_ARGS', message: 'cmd required' }, durationMs: Date.now() - started };
        const r = await this.hdcRun(`shell ${cmd}`);
        return { actionId: action.id, outcome: r.code === 0 ? 'success' : 'failure', output: r.stdout.slice(0, 2_000), error: r.code === 0 ? undefined : { code: 'E_HDC', message: r.stderr.slice(0, 300) }, durationMs: Date.now() - started, cost: 2 };
      }
      case 'hdc-aa-start': {
        const bundle = String(action.args.bundle ?? '');
        const ability = String(action.args.ability ?? '');
        if (!bundle || !ability) return { actionId: action.id, outcome: 'failure', error: { code: 'E_ARGS', message: 'bundle and ability required' }, durationMs: Date.now() - started };
        const r = await this.hdcRun(`shell aa start -a ${ability} -b ${bundle}`);
        return { actionId: action.id, outcome: r.code === 0 && /start ability successfully|success/i.test(r.stdout) ? 'success' : 'failure', output: r.stdout.slice(0, 1_000), error: r.code === 0 ? undefined : { code: 'E_AA', message: r.stderr.slice(0, 300) }, durationMs: Date.now() - started, cost: 3 };
      }
      case 'hdc-install': {
        const path = String(action.args.path ?? '');
        if (!path) return { actionId: action.id, outcome: 'failure', error: { code: 'E_ARGS', message: 'path required' }, durationMs: Date.now() - started };
        const r = await this.hdcRun(`install "${path}"`);
        return { actionId: action.id, outcome: r.code === 0 && /success|install ok/i.test(r.stdout + r.stderr) ? 'success' : 'failure', output: (r.stdout + r.stderr).slice(0, 1_000), durationMs: Date.now() - started, cost: 8 };
      }
      default:
        return { actionId: action.id, outcome: 'failure', error: { code: 'E_UNKNOWN_ACTION', message: `unknown action type ${action.type}` }, durationMs: Date.now() - started };
    }
  }

  async snapshot(): Promise<Snapshot> {
    const obs = await this.observe();
    return {
      environmentId: this.id,
      version: 1,
      takenAt: new Date().toISOString(),
      stateHash: stableHash(obs.state),
      payload: obs.state,
    };
  }

  async restore(snapshot: Snapshot): Promise<void> {
    // device state is not snapshot-restorable; divergence audit only
    this.restoreAttempts.push(snapshot.takenAt);
  }

  async evaluate(): Promise<EnvironmentScore> {
    const obs = await this.observe();
    const state = obs.state as { devices: string[]; frontApp?: string };
    const metrics: Record<string, number> = {
      devicesConnected: state.devices.length,
      frontAppPresent: state.frontApp ? 1 : 0,
    };
    if (state.frontApp) {
      const logs = await this.hdcRun('shell hilog -x -z 100').catch(() => ({ code: 1, stdout: '', stderr: '' }));
      metrics.recentErrors = (logs.stdout.match(/\b(F|E)\//g) ?? []).length;
    }
    return { environmentId: this.id, metrics };
  }

  async close(): Promise<void> {
    this.lastStates = [];
  }

  private hdcOk(): Promise<boolean> {
    return this.hdcRun('list targets').then((r) => r.code === 0).catch(() => false);
  }

  private hdcRun(args: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return runShell(`${this.hdc} ${args}`, process.cwd(), this.timeoutMs);
  }
}
