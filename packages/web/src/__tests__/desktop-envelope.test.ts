/**
 * desktop envelope tests (2026-10-10, HMH Desktop 阶段E):
 * spawn the REAL desktop-host (desktop mode: loopback + port 0 + token),
 * drive an actual task through a 402 provider fixture, and pin the
 * event: hmh EventEnvelope frames that reach the SSE stream:
 *   run.started(task/mode) ... run.failed(bridge-code error shape),
 * plus the frame-level contract (schemaVersion/eventId/sessionId/runId/
 * seq per-run monotonic/occurredAt RFC3339) and the fact that they ride
 * the replay ring (Last-Event-ID catch-up after a mid-run disconnect).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const hostTs = join(here, '..', 'desktop-host.ts');
const TOKEN = randomBytes(32).toString('base64url');

interface Envelope {
  schemaVersion: number;
  eventId: string;
  sessionId: string;
  runId: string;
  seq: number;
  occurredAt: string;
  kind: string;
  payload: Record<string, unknown>;
}

interface Host {
  port: number;
  child: ChildProcess;
  home: string;
  fake: ReturnType<typeof createServer>;
}

async function startHost(): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-env-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  const fake = createServer((req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Insufficient Balance (test)' } }));
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const fakePort = (fake.address() as { port: number }).port;
  await writeFile(join(home, 'config.json'), JSON.stringify({
    providers: { fakepay: { baseUrl: `http://127.0.0.1:${fakePort}/v1`, model: 'm', apiKey: 'sk-x' } },
    routing: { chat: 'fakepay' },
    approval: 'auto',
    maxTurns: 2,
  }), 'utf8');

  const child = spawn(process.execPath, ['--import', 'tsx', hostTs], {
    cwd: here,
    env: { ...process.env, HMH_HOME: home, HMH_DESKTOP_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const port = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 30_000);
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const idx = buf.indexOf('\n');
      if (idx > 0) {
        try {
          const v = JSON.parse(buf.slice(0, idx)) as { hmhDesktopHostReady?: boolean; port?: number };
          if (v.hmhDesktopHostReady === true && typeof v.port === 'number') {
            clearTimeout(timer);
            resolve(v.port);
          }
        } catch { /* not json */ }
      }
    });
    child.on('exit', () => { clearTimeout(timer); resolve(null); });
  });
  if (port === null) {
    child.kill();
    await rm(home, { recursive: true, force: true });
    throw new Error('desktop-host bootstrap failed');
  }
  void child.on('exit', () => { void rm(home, { recursive: true, force: true }); void fake.close(); });
  return { port, child, home, fake };
}

/** 订阅 event: hmh 信封流(手工 SSE 解析;可选 Last-Event-ID)。 */
function subscribe(port: number, lastEventId?: string): { envelopes: Envelope[]; sseFrameIds: number[]; stop(): Promise<void> } {
  const envelopes: Envelope[] = [];
  const sseFrameIds: number[] = [];
  const ac = new AbortController();
  const task = (async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
      headers: {
        'x-hmh-key': TOKEN,
        accept: 'text/event-stream',
        ...(lastEventId !== undefined ? { 'last-event-id': lastEventId } : {}),
      },
      signal: ac.signal,
    });
    if (!res.ok || res.body === null) throw new Error(`SSE HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = '';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
          else if (line.startsWith('id:')) sseFrameIds.push(Number(line.slice(3).trim()));
        }
        if (event === 'hmh' && data) {
          try { envelopes.push(JSON.parse(data) as Envelope); } catch { /* skip */ }
        }
      }
    }
  })().catch(() => undefined);
  return {
    envelopes,
    sseFrameIds,
    stop: async () => {
      ac.abort();
      await task;
    },
  };
}

const waitUntil = async (check: () => boolean, ms = 30_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
};

const isEnvelopeShape = (e: Envelope): boolean =>
  e.schemaVersion === 1 &&
  typeof e.eventId === 'string' && e.eventId.length > 0 &&
  typeof e.sessionId === 'string' && e.sessionId.length > 0 &&
  typeof e.runId === 'string' && e.runId.startsWith('run-') &&
  Number.isInteger(e.seq) && e.seq > 0 &&
  Number.isFinite(Date.parse(e.occurredAt)) &&
  typeof e.payload === 'object' && e.payload !== null;

test('真实任务驱动:run.started → run.failed(provider 402)信封到达 SSE', async () => {
  const host = await startHost();
  try {
    const sub = subscribe(host.port);
    await new Promise((r) => setTimeout(r, 150));
    const r = await fetch(`http://127.0.0.1:${host.port}/api/task`, {
      method: 'POST',
      headers: { 'x-hmh-key': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello envelope', sessionId: 'env-t1', mode: 'auto' }),
    });
    assert.equal(r.status, 200);

    const done = await waitUntil(() => sub.envelopes.some((e) => e.kind === 'run.failed' || e.kind === 'run.completed'));
    assert.ok(done, `终态信封到达(收到:${sub.envelopes.map((e) => e.kind).join(',') || '无'})`);

    const started = sub.envelopes.find((e) => e.kind === 'run.started');
    assert.ok(started, 'run.started 信封存在');
    assert.ok(isEnvelopeShape(started!), 'run.started 信封形状合法');
    assert.equal(String(started!.payload.task ?? ''), 'hello envelope');
    assert.equal(String(started!.payload.mode ?? ''), 'auto');

    const failed = sub.envelopes.find((e) => e.kind === 'run.failed');
    assert.ok(failed, 'provider 402 → run.failed(而非永远 running)');
    const err = failed!.payload.error as { code: string; message: string; retryable: boolean };
    assert.ok(['AUTH_FAILED', 'RUNTIME_CRASHED'].includes(err.code), `桥级错误码(${err.code})`);
    assert.match(err.message, /HTTP 402|Balance|402/);
    assert.equal(typeof err.retryable, 'boolean');

    // 同一 run 内 seq 单调递增且无重复 eventId
    const seqs = sub.envelopes.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'seq 单调');
    const ids = new Set(sub.envelopes.map((e) => e.eventId));
    assert.equal(ids.size, sub.envelopes.length, 'eventId 全局唯一');
    await sub.stop();
  } finally {
    host.child.kill();
  }
});

test('信封走重放环:中途断线后 Last-Event-ID 补齐终态', async () => {
  const host = await startHost();
  try {
    const sub1 = subscribe(host.port);
    await new Promise((r) => setTimeout(r, 150));
    await fetch(`http://127.0.0.1:${host.port}/api/task`, {
      method: 'POST',
      headers: { 'x-hmh-key': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'replay test', sessionId: 'env-t2', mode: 'auto' }),
    });
    // 一收到 run.started 就断线(终态必然未到)
    await waitUntil(() => sub1.envelopes.some((e) => e.kind === 'run.started'));
    const lastId = String(sub1.sseFrameIds[sub1.sseFrameIds.length - 1] ?? 0);
    await sub1.stop();

    const sub2 = subscribe(host.port, lastId);
    const done = await waitUntil(() => sub2.envelopes.some((e) => e.kind === 'run.failed' || e.kind === 'run.completed'));
    assert.ok(done, `补拉拿到终态(收到:${sub2.envelopes.map((e) => e.kind).join(',') || '无'})`);
    await sub2.stop();
  } finally {
    host.child.kill();
  }
});
