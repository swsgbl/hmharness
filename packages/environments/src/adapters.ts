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
import { Arc3RestBridge, type Arc3Frame } from './arc3-rest.ts';

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
  /** live REST bridge (real runs); omit for the honest not-configured state */
  bridge?: Arc3RestBridge;
  /** game to play (game_id from GET /api/games); default: first listed */
  gameId?: string;
}

interface Arc3Session {
  cardId: string;
  gameId: string;
  guid?: string;
  lastFrame?: Arc3Frame;
  steps: number;
  totalReward: number;
}

export class Arc3Environment implements Environment {
  id = 'arc3';
  version = '1.0.0';
  private session: Arc3Session | null = null;

  constructor(private opts: Arc3EnvOptions = {}) {}

  async capabilities(): Promise<Capability[]> {
    const live = Boolean(this.opts.bridge);
    return [
      { kind: 'observe', detail: 'ARC-AGI-3 game frame via official REST API', limitation: live ? undefined : 'no bridge configured — runArc3() wires the official API (needs X-API-Key)' },
      { kind: 'act', detail: 'ACTION1-7 (ACTION6 = 64×64 coordinate), reasoning rides along', limitation: live ? undefined : 'not configured — refuses to fake runs' },
      { kind: 'evaluate', detail: 'scorecard aggregate via /api/scorecard/{card_id}', limitation: live ? undefined : 'bridge-gated' },
    ];
  }

  private ensureLive(): Arc3RestBridge {
    if (!this.opts.bridge) throw new Error('ARC3 not wired: construct via runArc3()/Arc3RestBridge (official REST API at three.arcprize.org, X-API-Key required)');
    return this.opts.bridge;
  }

  async reset(): Promise<Observation> {
    const bridge = this.ensureLive();
    if (!this.session) {
      const gameId = this.opts.gameId ?? (await bridge.listGames())[0]?.game_id;
      if (!gameId) throw new Error('E_ARC3_NO_GAMES: /api/games returned no titles');
      const cardId = await bridge.openScorecard({ tags: ['hmharness'] });
      this.session = { cardId, gameId, steps: 0, totalReward: 0 };
    }
    const frame = await bridge.reset(this.session.gameId, this.session.cardId, this.session.guid);
    this.session.guid = frame.guid;
    this.session.lastFrame = frame;
    this.session.steps = 0;
    return this.observe();
  }

  async observe(): Promise<Observation> {
    if (!this.session?.lastFrame) {
      // pre-reset: expose the affordance map without touching the API
      return {
        environmentId: this.id,
        timestamp: new Date().toISOString(),
        state: { configured: false, note: 'call reset() first (opens scorecard + starts a game instance)' },
        availableActions: this.actionSpecs(),
      };
    }
    const f = this.session.lastFrame as Arc3Frame & { available_actions?: Array<string | number>; levels_completed?: number; win_levels?: number; state?: unknown };
    return {
      environmentId: this.id,
      timestamp: new Date().toISOString(),
      state: {
        gameId: this.session.gameId,
        guid: this.session.guid,
        levelsCompleted: f.levels_completed ?? 0,
        winLevels: f.win_levels ?? 0,
        gameState: f.state ?? null,
        framePreview: Array.isArray(f.frame) ? f.frame.slice(0, 64) : f.frame,
        steps: this.session.steps,
      },
      availableActions: this.actionSpecs(f.available_actions),
      raw: f,
    };
  }

  private actionSpecs(available?: Array<string | number>): ActionSpec[] {
    const all: ActionSpec[] = [
      { id: 'a1', type: 'ACTION1', description: 'simple action 1 (game-defined, e.g. move up / option A)', cost: 1 },
      { id: 'a2', type: 'ACTION2', description: 'simple action 2', cost: 1 },
      { id: 'a3', type: 'ACTION3', description: 'simple action 3', cost: 1 },
      { id: 'a4', type: 'ACTION4', description: 'simple action 4', cost: 1 },
      { id: 'a5', type: 'ACTION5', description: 'simple action 5 (e.g. jump / fire / option E)', cost: 1 },
      { id: 'a6', type: 'ACTION6', description: 'coordinate action: click/tap at (x,y) on the 64×64 grid', argsSchema: { x: 'number 0-63', y: 'number 0-63' }, cost: 1 },
      { id: 'a7', type: 'ACTION7', description: 'undo (games that support it)', cost: 1 },
    ];
    // the live frame advertises which actions THIS game accepts — trust it
    // (the API returns action NUMBERS: [6] means only ACTION6)
    if (available && available.length > 0) {
      const set = new Set(available.map((a) => (typeof a === 'number' ? `ACTION${a}` : String(a).toUpperCase())));
      return all.filter((a) => set.has(a.type));
    }
    return all;
  }

  async act(action: Action): Promise<ActionResult> {
    const bridge = this.ensureLive();
    const started = Date.now();
    if (!this.session?.guid) {
      return { actionId: action.id, outcome: 'failure', error: { code: 'E_ARC3_NOT_STARTED', message: 'reset() first' }, durationMs: Date.now() - started };
    }
    try {
      let frame: Arc3Frame;
      const reasoning = action.reason !== undefined ? { reason: action.reason } : undefined;
      if (action.type === 'ACTION6') {
        frame = await bridge.actionXY(this.session.gameId, this.session.guid, Number(action.args.x ?? 32), Number(action.args.y ?? 32), reasoning);
      } else if (/^ACTION[1-5]|^ACTION7$/.test(action.type)) {
        frame = await bridge.action(this.session.gameId, this.session.guid, Number(action.type.replace('ACTION', '')) as 1 | 2 | 3 | 4 | 5 | 7, reasoning);
      } else {
        return { actionId: action.id, outcome: 'failure', error: { code: 'E_UNKNOWN_ACTION', message: `unknown ARC action ${action.type}` }, durationMs: Date.now() - started };
      }
      const before = (this.session.lastFrame as (Arc3Frame & { levels_completed?: number }) | undefined)?.levels_completed ?? 0;
      const after = (frame as Arc3Frame & { levels_completed?: number }).levels_completed ?? 0;
      this.session.lastFrame = frame;
      this.session.steps += 1;
      this.session.totalReward += frame.reward ?? 0;
      return {
        actionId: action.id,
        // outcome: the call landed; a level win shows as progress
        outcome: frame.status === 'DEAD' ? 'failure' : 'success',
        output: { levelsCompleted: after, levelProgressed: after > before, reward: frame.reward, status: frame.status },
        durationMs: Date.now() - started,
        cost: 1,
      };
    } catch (err) {
      return { actionId: action.id, outcome: 'failure', error: { code: 'E_ARC3_CALL', message: String(err).slice(0, 250) }, durationMs: Date.now() - started };
    }
  }

  async snapshot(): Promise<Snapshot> {
    if (!this.session) {
      return { environmentId: this.id, version: 1, takenAt: new Date().toISOString(), stateHash: 'arc3-not-started', payload: null };
    }
    // ARC sessions are server-side stateful: the snapshot records the handle
    // (guid) so a supervisor can resume, but cannot fork server state
    return {
      environmentId: this.id,
      version: 1,
      takenAt: new Date().toISOString(),
      stateHash: stableHash({ guid: this.session.guid, steps: this.session.steps }),
      payload: { cardId: this.session.cardId, gameId: this.session.gameId, guid: this.session.guid, steps: this.session.steps, totalReward: this.session.totalReward },
    };
  }

  async restore(snapshot: Snapshot): Promise<void> {
    const p = snapshot.payload as Arc3Session | null;
    if (p?.guid) this.session = { ...p };
  }

  async evaluate(): Promise<EnvironmentScore> {
    const bridge = this.ensureLive();
    if (!this.session) return { environmentId: this.id, metrics: {} };
    const summary = await bridge.getScorecard(this.session.cardId).catch(() => ({}) as Record<string, unknown>);
    const envs = (summary.environments ?? []) as Array<Record<string, unknown>>;
    const mine = envs.find((e) => e.id === this.session?.gameId || e.game_id === this.session?.gameId) ?? summary;
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    return {
      environmentId: this.id,
      metrics: {
        steps: this.session.steps,
        levelsCompleted: num(mine.levels_completed),
        levelCount: num(mine.level_count),
        actions: num(mine.actions),
        completed: num(mine.completed) || (mine.completed === true ? 1 : 0),
      },
      details: 'ARC-AGI-3 official scorecard',
    };
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.opts.bridge?.closeScorecard(this.session.cardId).catch(() => undefined);
      this.session = null;
    }
  }
}
