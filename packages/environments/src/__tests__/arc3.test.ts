import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arc3RestBridge, ARC3_BASE } from '../arc3-rest.ts';
import { Arc3Environment } from '../adapters.ts';

test('arc3 bridge: base URL and no-key behavior are explicit', async () => {
  assert.equal(ARC3_BASE, 'https://three.arcprize.org');
  const bridge = new Arc3RestBridge(); // no key anywhere
  await assert.rejects(
    () => bridge.listGames(),
    /E_NO_API_KEY.*arcprize\.org/s,
  );
});

test('arc3 bridge: cookie jar absorbs Set-Cookie and echoes it (session affinity)', async () => {
  const bridge = new Arc3RestBridge({ apiKey: 'k-test', baseUrl: 'http://127.0.0.1:1' });
  // build a fake fetch by hitting the private call path through health? simpler:
  // verify absorb+header logic through a stubbed global fetch
  const originalFetch = globalThis.fetch;
  let seenCookie = '';
  let setCookieCalls = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seenCookie = String((init?.headers as Record<string, string>)?.cookie ?? '');
    setCookieCalls += 1;
    const res = new Response('{"games":[{"game_id":"g1"}]}', { headers: { 'content-type': 'application/json' } });
    // emulate AWSALB affinity: first response sets it
    (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie = () =>
      setCookieCalls === 1 ? ['AWSALB=abc123; Path=/', 'AWSALBAPP=0; Path=/'] : [];
    return res;
  }) as typeof fetch;
  try {
    const first = await bridge.listGames();
    assert.deepEqual(first, [{ game_id: 'g1' }]);
    const second = await bridge.listGames();
    assert.equal(second.length, 1);
    assert.match(seenCookie, /AWSALB=abc123/);
    assert.match(seenCookie, /AWSALBAPP=0/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('arc3 environment: unwired still refuses honestly; pre-reset observe shows affordances', async () => {
  const env = new Arc3Environment();
  await assert.rejects(() => env.reset(), /ARC3 not wired/);
  const obs = await env.observe();
  assert.equal(obs.environmentId, 'arc3');
  assert.equal((obs.state as { configured: boolean }).configured, false);
  assert.equal(obs.availableActions.length, 7);
  assert.ok(obs.availableActions.some((a) => a.type === 'ACTION6'));
  const caps = await env.capabilities();
  assert.ok(caps.every((c) => c.limitation));
});

test('arc3 environment: full lifecycle against a stubbed bridge', async () => {
  const frame = (reward: number): { game_id: string; guid: string; score: number; reward: number; status: string; frame: number[] } => ({
    game_id: 'ls20-x', guid: 'guid-1', score: 10 + reward, reward, status: 'PLAYING', frame: [1, 2, 3],
  });
  const calls: string[] = [];
  const bridge = {
    listGames: async () => { calls.push('listGames'); return [{ game_id: 'ls20-x', title: 'LS20' }]; },
    openScorecard: async () => { calls.push('openScorecard'); return 'card-1'; },
    closeScorecard: async () => { calls.push('closeScorecard'); return {}; },
    getScorecard: async () => { calls.push('getScorecard'); return { environments: [{ game_id: 'ls20-x', score: 42, win_rate: 0.5 }] }; },
    reset: async () => { calls.push('reset'); return frame(0); },
    action: async (_g: string, _guid: string, n: number) => { calls.push(`action${n}`); return frame(n === 5 ? -1 : 1); },
    actionXY: async (_g: string, _guid: string, x: number, y: number) => { calls.push(`action6@${x},${y}`); return frame(1); },
  };
  const env = new Arc3Environment({ bridge: bridge as unknown as Arc3RestBridge, gameId: 'ls20-x' });
  const obs = await env.reset();
  // explicit gameId skips listGames; the discovery path is covered by its own stub
  assert.equal(calls[0], 'openScorecard');
  assert.equal(calls[1], 'reset');
  const state = obs.state as { gameId: string; guid: string };
  assert.equal(state.gameId, 'ls20-x');
  assert.equal(state.guid, 'guid-1');
  const a1 = await env.act({ id: 'x1', type: 'ACTION1', args: {} });
  assert.equal(a1.outcome, 'success');
  const a6 = await env.act({ id: 'x6', type: 'ACTION6', args: { x: 70, y: -3 } });
  assert.equal(a6.outcome, 'success');
  assert.ok(calls.includes('action6@70,-3'), 'stubbed bridge receives raw coords; clamping lives in the real bridge (next test)');
  const bad = await env.act({ id: 'xb', type: 'JUMP', args: {} });
  assert.equal(bad.outcome, 'failure');
  assert.equal(bad.error?.code, 'E_UNKNOWN_ACTION');
  const a5 = await env.act({ id: 'x5', type: 'ACTION5', args: {} });
  assert.equal(a5.outcome, 'failure', 'negative reward counts as failure');
  const score = await env.evaluate();
  assert.equal(score.metrics.score, 42);
  const snap = await env.snapshot();
  assert.match(snap.stateHash, /^[0-9a-f]+$/);
  await env.close();
  assert.ok(calls.includes('closeScorecard'));
});

test('arc3 bridge: ACTION6 clamps coordinates to the 64x64 grid', async () => {
  const bridge = new Arc3RestBridge({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1' });
  const originalFetch = globalThis.fetch;
  let sent: unknown = null;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ game_id: 'g', guid: 's', score: 0, reward: 0, status: 'PLAYING' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await bridge.actionXY('g', 's', 70, -3);
    assert.deepEqual({ x: (sent as { x: number }).x, y: (sent as { y: number }).y }, { x: 63, y: 0 });
    await bridge.actionXY('g', 's', 31.6, 31.4);
    assert.deepEqual({ x: (sent as { x: number }).x, y: (sent as { y: number }).y }, { x: 32, y: 31 }, 'rounds to nearest grid cell');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
