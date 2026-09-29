/**
 * @hmharness/environments - ARC-AGI-3 REST bridge (blueprint §14 / ARC-001..003)
 *
 * Implements the OFFICIAL ARC-AGI-3 REST API (spec: docs.arcprize.org/arc3v1.yaml):
 *   base  https://three.arcprize.org
 *   auth  X-API-Key header (issued from the ARC-AGI-3 web console)
 *   games GET /api/games | GET /api/games/{game_id}
 *   cards POST /api/scorecard/open -> {card_id} | /close | GET /api/scorecard/{card_id}
 *   play  POST /api/cmd/RESET {game_id, card_id, guid?} -> FrameResponse
 *         POST /api/cmd/ACTION1..5,7 {game_id, guid, reasoning?}
 *         POST /api/cmd/ACTION6 {game_id, guid, x(0..63), y(0..63), reasoning?}
 *
 * Games are stateful behind an AWS load balancer: every response may set
 * AWSALB* cookies that MUST be echoed on subsequent requests (session
 * affinity) — this bridge owns the cookie jar.
 *
 * The API key is read from (in order): explicit option, HMH_HOME config
 * `arc3.apiKey`, env ARC_API_KEY. Without a key every call fails with the
 * structured E_NO_API_KEY pointing at the console — no fake runs.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const ARC3_BASE = 'https://three.arcprize.org';

export interface Arc3Frame {
  game_id: string;
  guid: string;
  frame?: number[];
  score?: number;
  reward?: number;
  status?: string;
  [k: string]: unknown;
}

export interface Arc3Game {
  game_id: string;
  title?: string | null;
  tags?: string[] | null;
}

export class Arc3RestBridge {
  private cookies = new Map<string, string>();
  private key: string | null = null;
  private keyChecked = false;

  constructor(private opts: { apiKey?: string; baseUrl?: string; home?: string } = {}) {}

  private base(): string {
    return this.opts.baseUrl ?? ARC3_BASE;
  }

  private async apiKey(): Promise<string | null> {
    if (this.keyChecked) return this.key;
    this.keyChecked = true;
    if (this.opts.apiKey) {
      this.key = this.opts.apiKey;
      return this.key;
    }
    const env = process.env.ARC_API_KEY ?? process.env.ARC3_API_KEY;
    if (env) {
      this.key = env;
      return this.key;
    }
    try {
      const home = this.opts.home ?? join(homedir(), '.hmharness');
      const cfg = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as { arc3?: { apiKey?: string } };
      if (cfg.arc3?.apiKey) this.key = cfg.arc3.apiKey;
    } catch { /* no config: env/console only */ }
    return this.key;
  }

  private absorbCookies(res: Response): void {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const key = await this.apiKey();
    if (!key) {
      throw new Error('E_NO_API_KEY: ARC-AGI-3 requires an X-API-Key — create one at the ARC-AGI-3 web console (arcprize.org), then set config {arc3:{apiKey}} or env ARC_API_KEY');
    }
    const headers: Record<string, string> = { 'X-API-Key': key };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(this.base() + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`E_ARC3_NETWORK: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.absorbCookies(res);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`E_ARC3_HTTP_${res.status}: ${text.slice(0, 200)}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** GET /api/healthcheck — plain text when healthy */
  async health(): Promise<string> {
    const key = await this.apiKey();
    const res = await fetch(this.base() + '/api/healthcheck', {
      headers: key ? { 'X-API-Key': key } : {},
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => {
      throw new Error(`E_ARC3_NETWORK: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!res.ok) throw new Error(`E_ARC3_HTTP_${res.status}`);
    return res.text();
  }

  /** GET /api/games */
  async listGames(): Promise<Arc3Game[]> {
    const r = await this.call<{ games?: Arc3Game[] } | Arc3Game[]>('GET', '/api/games');
    return Array.isArray(r) ? r : (r.games ?? []);
  }

  /** POST /api/scorecard/open */
  async openScorecard(meta?: { source_url?: string; tags?: string[]; opaque?: unknown; competition_mode?: boolean }): Promise<string> {
    const r = await this.call<{ card_id: string }>('POST', '/api/scorecard/open', meta ?? {});
    return r.card_id;
  }

  /** POST /api/scorecard/close */
  async closeScorecard(cardId: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>('POST', '/api/scorecard/close', { card_id: cardId });
  }

  /** GET /api/scorecard/{card_id} */
  async getScorecard(cardId: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>('GET', `/api/scorecard/${encodeURIComponent(cardId)}`);
  }

  /** POST /api/cmd/RESET — no guid: new instance; with guid: level/game reset */
  async reset(gameId: string, cardId: string, guid?: string): Promise<Arc3Frame> {
    const body: Record<string, unknown> = { game_id: gameId, card_id: cardId };
    if (guid) body.guid = guid;
    return this.call<Arc3Frame>('POST', '/api/cmd/RESET', body);
  }

  /** ACTION1..5, ACTION7 (simple) */
  async action(gameId: string, guid: string, n: 1 | 2 | 3 | 4 | 5 | 7, reasoning?: unknown): Promise<Arc3Frame> {
    const body: Record<string, unknown> = { game_id: gameId, guid };
    if (reasoning !== undefined) body.reasoning = reasoning;
    return this.call<Arc3Frame>('POST', `/api/cmd/ACTION${n}`, body);
  }

  /** ACTION6 (coordinate, 64x64 grid) */
  async actionXY(gameId: string, guid: string, x: number, y: number, reasoning?: unknown): Promise<Arc3Frame> {
    const body: Record<string, unknown> = { game_id: gameId, guid, x: Math.max(0, Math.min(63, Math.round(x))), y: Math.max(0, Math.min(63, Math.round(y))) };
    if (reasoning !== undefined) body.reasoning = reasoning;
    return this.call<Arc3Frame>('POST', '/api/cmd/ACTION6', body);
  }
}
