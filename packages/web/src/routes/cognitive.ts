/**
 * @hmharness/web - cognitive routes (extracted from server.ts, 2026-10-16;
 * web split slice 1 per the v33 audit's 4.1 architecture guidance).
 *
 * All eight endpoints are READ-ONLY projections of the cognitive stores
 * under HMH_HOME — they never mutate state and never touch the live task
 * machinery, which is why they extract cleanly. Bodies moved VERBATIM from
 * server.ts; the API contract (paths, query params, response shapes,
 * error-truncation posture) is unchanged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** the tiny JSON responder server.ts has always used (injected, not duplicated) */
export type JsonFn = (res: ServerResponse, status: number, body: unknown) => void;

export interface CognitiveRouteDeps {
  home: string;
  json: JsonFn;
}

/** Returns true when the request was handled (server.ts stops matching). */
export async function handleCognitiveRoute(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  deps: CognitiveRouteDeps,
): Promise<boolean> {
  const { home, json } = deps;
  if (req.method === 'GET' && url.pathname === '/api/cognitive/drift') {
    try {
      const { analyzeGoalDrift } = await import('@hmharness/cognitive');
      const order = url.searchParams.get('order') === 'time' ? 'time' : 'score';
      json(res, 200, { views: (await analyzeGoalDrift(home, 100, order)).slice(0, 12) });
    } catch (err) {
      json(res, 500, { error: String(err).slice(0, 200) });
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/cognitive/skills') {
    try {
      const { skillCandidatesFromHistory } = await import('@hmharness/cognitive');
      json(res, 200, { candidates: (await skillCandidatesFromHistory(home)).slice(0, 8) });
    } catch (err) {
      json(res, 500, { error: String(err).slice(0, 200) });
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/cognitive/trajectories') {
    try {
      const { listTrajectoryIds } = await import('@hmharness/cognitive');
      json(res, 200, { trajectories: await listTrajectoryIds(home, 30) });
    } catch (err) {
      json(res, 500, { error: String(err).slice(0, 200) });
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/cognitive/replay') {
    try {
      const { replayTrajectory } = await import('@hmharness/cognitive');
      const id = url.searchParams.get('id') ?? 'latest';
      const view = await replayTrajectory(home, id);
      if (!view) { json(res, 404, { error: `trajectory '${id}' not found` }); return true; }
      json(res, 200, view);
    } catch (err) {
      json(res, 500, { error: String(err).slice(0, 200) });
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/cognitive/transfer') {
    try {
      const { readFile } = await import('node:fs/promises');
      const { join: j } = await import('node:path');
      const text = await readFile(j(home, 'cognitive', 'transfer.jsonl'), 'utf8');
      const experiments = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).slice(-50);
      json(res, 200, { experiments });
    } catch {
      json(res, 200, { experiments: [] });
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/cognitive/team') {
    try {
      const { teamLog, liveTopologySnapshot } = await import('@hmharness/agent');
      json(res, 200, { events: await teamLog(40), live: liveTopologySnapshot() });
    } catch (err) {
      json(res, 500, { error: String(err).slice(0, 200) });
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/cognitive/calibration') {
    try {
      const { calibrationReport, calibrationTrend } = await import('@hmharness/cognitive');
      const env = url.searchParams.get('env') ?? undefined;
      if (url.searchParams.get('trend') === '1') {
        json(res, 200, await calibrationTrend(home, 5, env));
      } else {
        json(res, 200, await calibrationReport(home));
      }
    } catch (err) {
      json(res, 500, { error: String(err).slice(0, 200) });
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/cognitive') {
    // research dashboard seed (blueprint RD-001..008): read-only status
    // of the cognitive subsystems — memory layers, trajectory store,
    // evolution audit tail, environment registry.
    try {
      const { cognitiveStatus } = await import('@hmharness/cognitive');
      json(res, 200, await cognitiveStatus(home));
    } catch (err) {
      json(res, 500, { error: String(err).slice(0, 200) });
    }
    return true;
  }
  return false;
}
