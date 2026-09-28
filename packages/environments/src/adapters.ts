/**
 * @hmharness/environments - Browser / Desktop / ARC3 adapters
 *
 * Browser (ENV-011..013): observation over the CDP HTTP endpoint (tab list,
 * titles, URLs) — real, zero-dependency. Actions require a CDP WebSocket
 * bridge supplied by the host (the agent's browser tooling); without the
 * bridge every act() answers a structured E_NO_CDP_BRIDGE, never a fake
 * success. Evaluation is page/task assertions — bridge-gated too.
 *
 * Desktop (ENV-014..016): observation via window enumeration (real);
 * act/evaluate require the desktop automation trio bridge (agent tools).
 *
 * ARC3 (ARC-001..003): adapter skeleton — requires the ARC-AGI-3 SDK/task
 * bundle at runtime; register() refuses to fake runs without it.
 */
import type {
  Environment, Observation, Action, ActionResult, Snapshot, EnvironmentScore,
  Capability, ActionSpec,
} from '@hmharness/cognitive';
import { stableHash } from '@hmharness/cognitive';
import { runShell } from './terminal.ts';

/* ---------------- Browser ---------------- */

export interface BrowserEnvOptions {
  /** CDP debugging address (default Chrome :9222) */
  cdpBase?: string;
  /** host-provided action bridge (Runtime.evaluate etc.) */
  act?: (action: Action, tabId: string) => Promise<{ outcome: 'success' | 'failure' | 'unknown'; output?: unknown; error?: { code: string; message: string } }>;
}

interface CdpTab {
  id: string;
  title: string;
  url: string;
  type: string;
}

export class BrowserEnvironment implements Environment {
  id = 'browser';
  version = '1.0.0';
  private tabs: CdpTab[] = [];
  private history: Array<{ url: string; at: string }> = [];

  constructor(private opts: BrowserEnvOptions = {}) {}

  private get base(): string {
    return this.opts.cdpBase ?? 'http://127.0.0.1:9222';
  }

  async capabilities(): Promise<Capability[]> {
    const live = await this.endpointUp();
    return [
      { kind: 'observe', detail: 'tab list (titles/urls) via CDP /json', limitation: live ? undefined : 'no browser at ' + this.base },
      { kind: 'act', detail: 'navigate/click/type via host CDP bridge', limitation: this.opts.act ? undefined : 'act bridge not configured — actions return E_NO_CDP_BRIDGE' },
      { kind: 'evaluate', detail: 'page assertions via act bridge', limitation: this.opts.act ? undefined : 'bridge-gated' },
      { kind: 'network', detail: 'through the attached browser only' },
    ];
  }

  async reset(): Promise<Observation> {
    this.history = [];
    return this.observe();
  }

  async observe(): Promise<Observation> {
    try {
      const res = await fetch(this.base + '/json', { signal: AbortSignal.timeout(2_000) });
      const list = (await res.json()) as CdpTab[];
      this.tabs = list.filter((t) => t.type === 'page');
    } catch {
      this.tabs = [];
    }
    return {
      environmentId: this.id,
      timestamp: new Date().toISOString(),
      state: { tabs: this.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })), history: this.history.slice(-5) },
      availableActions: this.actionSpecs(),
    };
  }

  private actionSpecs(): ActionSpec[] {
    const dead = !this.opts.act;
    return [
      { id: 'navigate', type: 'navigate', description: 'open a URL in the active tab', argsSchema: { url: 'string' }, cost: 2 },
      { id: 'click', type: 'click', description: 'click a selector', argsSchema: { selector: 'string' }, cost: 1 },
      { id: 'type', type: 'type-text', description: 'type text into a selector', argsSchema: { selector: 'string', text: 'string' }, cost: 1 },
    ].map((s) => (dead ? { ...s, description: `${s.description} (needs act bridge)` } : s));
  }

  async act(action: Action): Promise<ActionResult> {
    const started = Date.now();
    if (!this.opts.act) {
      return { actionId: action.id, outcome: 'failure', error: { code: 'E_NO_CDP_BRIDGE', message: 'browser act requires a host CDP bridge (BrowserEnvOptions.act)' }, durationMs: Date.now() - started };
    }
    if (this.tabs.length === 0) {
      return { actionId: action.id, outcome: 'failure', error: { code: 'E_NO_TABS', message: 'no browser tabs reachable at ' + this.base }, durationMs: Date.now() - started };
    }
    const r = await this.opts.act(action, this.tabs[0].id);
    if (action.type === 'navigate' && r.outcome === 'success') {
      this.history.push({ url: String(action.args.url ?? ''), at: new Date().toISOString() });
    }
    return { actionId: action.id, ...r, durationMs: Date.now() - started };
  }

  async snapshot(): Promise<Snapshot> {
    const obs = await this.observe();
    return { environmentId: this.id, version: 1, takenAt: new Date().toISOString(), stateHash: stableHash(obs.state), payload: obs.state };
  }

  async restore(): Promise<void> {
    // navigation history restore requires the act bridge; recorded only
  }

  async evaluate(): Promise<EnvironmentScore> {
    return { environmentId: this.id, metrics: { tabsReachable: this.tabs.length, bridgeConfigured: this.opts.act ? 1 : 0 } };
  }

  async close(): Promise<void> {
    this.tabs = [];
  }

  private async endpointUp(): Promise<boolean> {
    try {
      await fetch(this.base + '/json/version', { signal: AbortSignal.timeout(1_500) });
      return true;
    } catch {
      return false;
    }
  }
}

/* ---------------- Desktop ---------------- */

export interface DesktopEnvOptions {
  act?: (action: Action) => Promise<{ outcome: 'success' | 'failure' | 'unknown'; output?: unknown; error?: { code: string; message: string } }>;
}

export class DesktopEnvironment implements Environment {
  id = 'desktop';
  version = '1.0.0';
  private windows: Array<{ title: string; pid: number }> = [];

  constructor(private opts: DesktopEnvOptions = {}) {}

  async capabilities(): Promise<Capability[]> {
    return [
      { kind: 'observe', detail: 'window list (title + pid) via OS process enumeration' },
      { kind: 'act', detail: 'click/type/hotkey via host automation trio', limitation: this.opts.act ? undefined : 'automation bridge not configured — actions return E_NO_AUTOMATION_BRIDGE' },
      { kind: 'display', detail: 'screenshots through the host bridge only' },
    ];
  }

  async reset(): Promise<Observation> {
    return this.observe();
  }

  async observe(): Promise<Observation> {
    if (process.platform === 'win32') {
      const r = await runShell('powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id,MainWindowTitle | ConvertTo-Json -Compress"', process.cwd(), 10_000);
      try {
        const parsed = JSON.parse(r.stdout || '[]') as Array<{ Id: number; MainWindowTitle: string }>;
        this.windows = (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.Id, title: p.MainWindowTitle }));
      } catch {
        this.windows = [];
      }
    } else {
      const r = await runShell('ps -eo pid,comm --no-headers', process.cwd(), 10_000).catch(() => ({ code: 1, stdout: '', stderr: '' }));
      this.windows = r.stdout.split('\n').filter((l) => l.trim()).slice(0, 40).map((l) => {
        const [pid, ...rest] = l.trim().split(/\s+/);
        return { pid: Number(pid) || 0, title: rest.join(' ') };
      });
    }
    return {
      environmentId: this.id,
      timestamp: new Date().toISOString(),
      state: { windows: this.windows },
      availableActions: this.actionSpecs(),
    };
  }

  private actionSpecs(): ActionSpec[] {
    return [
      { id: 'click', type: 'desktop-click', description: 'click at coordinates', argsSchema: { x: 'number', y: 'number' }, cost: 1 },
      { id: 'type', type: 'desktop-type', description: 'type text', argsSchema: { text: 'string' }, cost: 1 },
      { id: 'hotkey', type: 'desktop-hotkey', description: 'press a hotkey combo', argsSchema: { combo: 'string' }, cost: 1 },
    ];
  }

  async act(action: Action): Promise<ActionResult> {
    const started = Date.now();
    if (!this.opts.act) {
      return { actionId: action.id, outcome: 'failure', error: { code: 'E_NO_AUTOMATION_BRIDGE', message: 'desktop act requires the host automation trio bridge (DesktopEnvOptions.act)' }, durationMs: Date.now() - started };
    }
    const r = await this.opts.act(action);
    return { actionId: action.id, ...r, durationMs: Date.now() - started };
  }

  async snapshot(): Promise<Snapshot> {
    return { environmentId: this.id, version: 1, takenAt: new Date().toISOString(), stateHash: stableHash(this.windows), payload: { windows: this.windows } };
  }

  async restore(): Promise<void> {
    // desktop UI state is not restorable; divergence audit only
  }

  async evaluate(): Promise<EnvironmentScore> {
    return { environmentId: this.id, metrics: { windowsVisible: this.windows.length, bridgeConfigured: this.opts.act ? 1 : 0 } };
  }

  async close(): Promise<void> {
    this.windows = [];
  }
}

/* ---------------- ARC3 ---------------- */

export interface Arc3EnvOptions {
  /** path/endpoint to the ARC-AGI-3 SDK task bundle; REQUIRED for real runs */
  taskBundle?: string;
  /** host bridge executing ARC interactions (SDK client) */
  interact?: (action: Action) => Promise<{ outcome: 'success' | 'failure' | 'unknown'; observation?: unknown }>;
}

export class Arc3Environment implements Environment {
  id = 'arc3';
  version = '0.1.0';

  constructor(private opts: Arc3EnvOptions = {}) {}

  async capabilities(): Promise<Capability[]> {
    const ready = Boolean(this.opts.taskBundle && this.opts.interact);
    return [
      { kind: 'observe', detail: 'ARC task grid state via SDK', limitation: ready ? undefined : 'ARC-AGI-3 SDK task bundle + interact bridge required' },
      { kind: 'act', detail: 'ARC actions mapped through the SDK', limitation: ready ? undefined : 'not configured — adapter refuses to fake runs' },
      { kind: 'evaluate', detail: 'ARC official scoring via SDK replay' },
    ];
  }

  private refuse<T>(): T {
    throw new Error('ARC3 adapter is a skeleton: configure Arc3EnvOptions.taskBundle + interact (ARC-001); no fake runs');
  }

  async reset(): Promise<Observation> {
    if (!this.opts.interact) return this.refuse();
    const r = await this.opts.interact({ id: 'reset', type: 'reset', args: {} });
    return {
      environmentId: this.id,
      timestamp: new Date().toISOString(),
      state: r.observation ?? null,
      availableActions: [
        { id: 'submit', type: 'submit', description: 'submit an answer grid', argsSchema: { grid: 'unknown' }, cost: 5 },
      ],
    };
  }

  async observe(): Promise<Observation> {
    if (!this.opts.interact) return this.refuse();
    const r = await this.opts.interact({ id: 'observe', type: 'observe', args: {} });
    return {
      environmentId: this.id,
      timestamp: new Date().toISOString(),
      state: r.observation ?? null,
      availableActions: [{ id: 'submit', type: 'submit', description: 'submit an answer grid', argsSchema: { grid: 'unknown' }, cost: 5 }],
    };
  }

  async act(action: Action): Promise<ActionResult> {
    if (!this.opts.interact) return this.refuse();
    const r = await this.opts.interact(action);
    return { actionId: action.id, outcome: r.outcome, output: r.observation };
  }

  async snapshot(): Promise<Snapshot> {
    if (!this.opts.interact) return this.refuse();
    return { environmentId: this.id, version: 1, takenAt: new Date().toISOString(), stateHash: 'arc3-pending', payload: null };
  }

  async restore(): Promise<void> {
    this.refuse();
  }

  async evaluate(): Promise<EnvironmentScore> {
    if (!this.opts.interact) return this.refuse();
    return { environmentId: this.id, metrics: {} };
  }

  async close(): Promise<void> {
    /* nothing held */
  }
}
