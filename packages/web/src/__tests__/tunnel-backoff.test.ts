/**
 * Tunnel retry-policy tests (2026-10-29 device incident root-cause).
 *
 * The board looped all night — cloudflared download fails -> pinggy comes
 * up -> dies in seconds -> "restarting in 3s (1/5)" forever — because the
 * old exit-watcher reset its counter on ANY successful spawn. These tests
 * pin the fix: the pure backoff ladders, the give-up budget (no spawn after
 * it is spent), the one-shot notice, and the stable-session reset that
 * keeps blip recovery fast on healthy networks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mock } from 'node:test';
import {
  TunnelManager,
  startupRetryDelayMs,
  reconnectDelayMs,
  MAX_CONSECUTIVE_FAILURES,
  RETRY_CAP_MS,
  STABLE_UPTIME_MS,
} from '../tunnel.ts';

/** let the microtask chain (async boot -> catch -> schedule) run to completion */
const settle = () => new Promise<void>((r) => setImmediate(r));

/** never touches a real process: both providers "fail" like a restricted network */
class DeadTunnel extends TunnelManager {
  spawns = 0;
  protected async startCloudflare(): Promise<{ url: string; provider: 'cloudflare'; child: ChildProcess }> {
    this.spawns += 1;
    throw new Error('simulated: cloudflared unavailable');
  }
  protected async startPinggy(): Promise<{ url: string; provider: 'pinggy'; child: ChildProcess }> {
    this.spawns += 1;
    throw new Error('simulated: pinggy unavailable');
  }
}

/** boots fine every time, but the session dies instantly — the incident's loop */
class FlappyTunnel extends TunnelManager {
  boots = 0;
  lastChild?: EventEmitter;
  protected async startCloudflare(): Promise<{ url: string; provider: 'pinggy'; child: ChildProcess }> {
    this.boots += 1;
    const child = new EventEmitter();
    this.lastChild = child;
    return { url: `https://s${this.boots}.pinggy.link`, provider: 'pinggy', child: child as unknown as ChildProcess };
  }
}

test('cold-start backoff ladder: 3,6,12,24,48 … capped at 5 minutes', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map(startupRetryDelayMs),
    [3_000, 6_000, 12_000, 24_000, 48_000, 96_000, 192_000, 300_000],
  );
  assert.equal(startupRetryDelayMs(50), RETRY_CAP_MS);
  // out-of-range attempts clamp to attempt 1, never 0/negative delay
  assert.equal(startupRetryDelayMs(0), 3_000);
  assert.equal(startupRetryDelayMs(-3), 3_000);
});

test('reconnect ladder: 1s/3s/5s fast first, then exponential to the same cap', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(reconnectDelayMs),
    [1_000, 3_000, 5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000],
  );
  assert.equal(reconnectDelayMs(0), 1_000);
});

test('cold-start failures back off, then give up: no spawn after the budget is spent', async () => {
  const t = new DeadTunnel();
  const notices: string[] = [];
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const s0 = await t.start(7788, 'cloudflare', undefined, (m) => notices.push(m));
    assert.equal(s0.url, undefined);
    assert.equal(t.spawns, 2); // attempt 1 burned cloudflare AND pinggy
    // backoff ladder 3s,6s,12s,24s — one more failed attempt per tick
    const ladder: Array<[number, number]> = [[3_000, 4], [6_000, 6], [12_000, 8], [24_000, 10]];
    for (const [delay, spawnsAfter] of ladder) {
      mock.timers.tick(delay);
      await settle();
      assert.equal(t.spawns, spawnsAfter);
    }
    // 5 consecutive failures -> terminal state + exactly ONE notice
    assert.equal(t.state.failed, true);
    assert.equal(notices.length, 1);
    assert.match(t.state.error ?? '', /gave up after 5 consecutive failures/);
    assert.match(notices[0], /停止自动重试/);
    // long after giving up: no further spawn, no second notice
    mock.timers.tick(10 * 60_000);
    await settle();
    assert.equal(t.spawns, 10);
    assert.equal(notices.length, 1);
    // a manual retry is a fresh explicit ask: budget granted again
    const s1 = await t.start(7788, 'cloudflare', undefined, (m) => notices.push(m));
    assert.equal(s1.failed, false);
    assert.equal(t.spawns, 12);
  } finally {
    mock.timers.reset();
    await t.stop();
  }
});

test('short-lived online sessions count as failures: 5 flaps, then give up', async () => {
  const t = new FlappyTunnel();
  const notices: string[] = [];
  const lines: string[] = [];
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const s = await t.start(7788, 'cloudflare', (m) => lines.push(m), (m) => notices.push(m));
    assert.equal(s.url, 'https://s1.pinggy.link');
    assert.equal(t.state.active, true);
    // first reconnect is the fast 1s slot (blips heal quickly)
    let sawFast = false;
    for (let flap = 1; flap <= 4; flap++) {
      t.lastChild!.emit('exit'); // dies within seconds of coming up
      await settle();
      sawFast ||= /reconnecting in 1s/.test(lines[lines.length - 1] ?? '');
      mock.timers.tick(reconnectDelayMs(flap)); // 1s,3s,5s,10s
      await settle();
      assert.equal(t.boots, flap + 1);
      assert.equal(t.state.active, true);
    }
    assert.ok(sawFast, 'first reconnect used the fast 1s slot');
    t.lastChild!.emit('exit'); // 5th consecutive failure
    await settle();
    assert.equal(t.state.failed, true);
    assert.equal(t.state.active, false);
    assert.equal(notices.length, 1);
    mock.timers.tick(10 * 60_000);
    await settle();
    assert.equal(t.boots, 5); // gave up: no 6th boot
  } finally {
    mock.timers.reset();
    await t.stop();
  }
});

test('a stable session resets the streak: healthy networks keep fast reconnects', async () => {
  const t = new FlappyTunnel();
  const lines: string[] = [];
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await t.start(7788, 'cloudflare', (m) => lines.push(m));
    // each round: the fresh session "stayed up" past STABLE_UPTIME_MS before dying
    const probe = t as unknown as { _startedAt?: number };
    for (let round = 1; round <= MAX_CONSECUTIVE_FAILURES + 1; round++) {
      probe._startedAt = Date.now() - STABLE_UPTIME_MS - 1_000;
      t.lastChild!.emit('exit');
      await settle();
      assert.equal(t.state.failed, false, `round ${round}: a stable exit never accumulates toward give-up`);
      mock.timers.tick(reconnectDelayMs(1)); // streak reset -> always the 1s slot
      await settle();
    }
    const reconnectLogs = lines.filter((l) => l.includes('reconnecting'));
    assert.ok(reconnectLogs.length >= MAX_CONSECUTIVE_FAILURES + 1);
    assert.ok(reconnectLogs.every((l) => /reconnecting in 1s/.test(l)), 'every post-stability reconnect stayed in the fast 1s slot');
  } finally {
    mock.timers.reset();
    await t.stop();
  }
});
