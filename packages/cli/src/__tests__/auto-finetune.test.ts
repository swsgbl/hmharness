/**
 * `hmh auto-finetune` against a stand-in for the provider (2026-11-27).
 *
 * The evolution daemon runs this command after every cycle, with --submit.
 * On one machine that went on for 50 days against a service the provider had
 * retired: three requests and a failed upload each time, exit code 0, no
 * record, and 13 identical training files from the days before that. Every
 * step below is one of the things that went wrong, now going right:
 *
 *   upload fails      -> a ledger row says so
 *   the next cycle    -> waits a day instead of trying again
 *   upload ok, job no -> the files are remembered with the rows
 *   the next attempt  -> reuses them, uploads nothing
 *   a real submission -> the cooldown it always had
 *   provider retired  -> answered with no request at all
 *
 * The stand-in speaks the provider's protocol on loopback; the clock comes
 * from HMH_FINETUNE_NOW, so a cooldown is minutes of test time, not days.
 * The provider's own page is the source for each status the stand-in answers
 * with (see cloud-finetune.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../main.ts', import.meta.url));
const T0 = Date.parse('2026-11-01T00:00:00Z');
const at = (hours: number) => new Date(T0 + hours * 3_600_000).toISOString();

interface Seen { method: string; path: string; body: string }
interface StandIn { url: string; seen: Seen[]; mode: { upload: 'ok' | 'fail'; create: 'ok' | 'fail' }; close(): Promise<void> }

/** Answers like the provider did: the model probe is rejected for the main
 *  model, "参数校验解析异常" for the rest (which reads as usable); uploads and
 *  job creation follow `mode`. */
async function provider(): Promise<StandIn> {
  const seen: Seen[] = [];
  const mode = { upload: 'ok' as 'ok' | 'fail', create: 'ok' as 'ok' | 'fail' };
  let files = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => { void handle(req, res); });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = '';
    for await (const part of req) body += part;
    const path = String(req.url ?? '');
    seen.push({ method: String(req.method ?? ''), path, body });
    const json = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.method === 'GET') return json(200, { data: [] });
    if (path.endsWith('/files')) {
      return mode.upload === 'fail'
        ? json(500, { error: { code: '500', message: '文件上传失败' } })
        : json(200, { id: 'file-' + (++files), bytes: body.length, samples: 1, text_stats: [{ tokens: 10 }] });
    }
    if (path.endsWith('/fine_tuning/jobs')) {
      const payload = JSON.parse(body) as { model: string; training_file: string };
      if (payload.training_file === 'file-probe-invalid') {
        return payload.model === 'm'
          ? json(404, { error: { code: '1608', message: '微调模型不存在' } })
          : json(400, { error: { code: '400', message: '参数校验解析异常' } });
      }
      return mode.create === 'fail'
        ? json(500, { error: { code: '500', message: '参数校验解析异常' } })
        : json(200, { id: 'job-1', status: 'queued', model: payload.model });
    }
    json(404, {});
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  // the handler closes over this one object: change its fields, never replace it
  return {
    // the host part carries the provider's name so the backend registry matches it
    url: `http://127.0.0.1:${port}/bigmodel.cn/api/paas/v4`,
    seen, mode,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

async function home(url: string, finetune?: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-autoft-'));
  await mkdir(join(dir, 'evolution'), { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    tui: { autoUpdate: false },
    providers: { glm: { baseUrl: url, apiKey: 'k', model: 'm' } },
    routing: { chat: 'glm' },
    ...(finetune ? { finetune } : {}),
  }), 'utf8');
  // 60 judge labels (the gate wants 50) and a few preference pairs
  await writeFile(join(dir, 'evolution', 'judge-labels.jsonl'), Array.from({ length: 60 }, () => JSON.stringify({ verdict: 'good' })).join('\n'), 'utf8');
  const pair = (i: number, split?: string) => JSON.stringify({ prompt: 'task ' + i, chosen: 'good ' + i, rejected: 'bad ' + i, ...(split ? { split } : {}) });
  await writeFile(join(dir, 'evolution', 'dpo-pairs.jsonl'), [
    pair(1), pair(2, 'eval'), pair(3), pair(4), pair(5, 'eval'), pair(6), pair(7), pair(8, 'eval'), pair(9),
  ].join('\n') + '\n', 'utf8');
  return dir;
}

function cli(args: string[], home: string, now: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', MAIN, ...args], {
      env: { ...process.env, HMH_HOME: home, HMH_LOCALE: 'zh', HMH_FINETUNE_NOW: now },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('auto-finetune did not exit in time:\n' + out.slice(-600))); }, 180_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, '') }); });
  });
}

const ledger = async (home: string) => (await readFile(join(home, 'evolution', 'finetune-jobs.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const count = (seen: Seen[], method: string, tail: string, from = 0) => seen.slice(from).filter((s) => s.method === method && s.path.endsWith(tail)).length;
const drop = (home: string) => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

test('auto-finetune: a failed upload is recorded, the next cycle waits, files are reused, a submission cools down', { timeout: 10 * 60_000 }, async () => {
  const p = await provider();
  const h = await home(p.url);
  try {
    // 1. the upload fails: said on the output AND in the ledger
    p.mode.upload = 'fail'; p.mode.create = 'ok';
    let r = await cli(['auto-finetune', '--submit'], h, at(0));
    assert.equal(r.code, 0, r.out.slice(-300));
    assert.match(r.out, /上传失败：Error: HTTP 500: 文件上传失败/);
    let rows = await ledger(h);
    assert.equal(rows.length, 1, 'one ledger row');
    assert.equal(rows[0]!.status, 'upload-failed');
    assert.match(String(rows[0]!.error), /文件上传失败/);
    assert.equal(rows[0]!.trainFile, undefined, 'nothing reached the cloud');
    assert.match(String(rows[0]!.pairsDigest), /^[0-9a-f]{64}$/);
    const afterFirst = p.seen.length;
    assert.equal(count(p.seen, 'POST', '/files'), 1, 'the upload was tried once');

    // 2. the next cycle, an hour later: no request at all
    r = await cli(['auto-finetune', '--submit'], h, at(1));
    assert.match(r.out, /上次尝试失败不满 24 小时（upload-failed）——稍后再试/);
    assert.equal(p.seen.length, afterFirst, 'not one request');

    // 3. a day later the upload works, the job does not: the files are remembered
    p.mode.upload = 'ok'; p.mode.create = 'fail';
    r = await cli(['auto-finetune', '--submit'], h, at(25));
    assert.match(r.out, /任务创建失败/);
    assert.doesNotMatch(r.out, /复用上次已上传/, 'first time up: nothing to reuse');
    rows = await ledger(h);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.status, 'staged');
    assert.equal(rows[1]!.trainFile, 'file-1');
    assert.equal(rows[1]!.evalFile, 'file-2');
    assert.equal(rows[1]!.pairsDigest, rows[0]!.pairsDigest, 'the same rows, the same digest');
    assert.equal(rows[1]!.pairs, 9, '6 training + 3 validation rows');
    const afterStaged = p.seen.length;
    assert.equal(count(p.seen, 'POST', '/files', afterFirst), 2, 'train and eval uploaded once each');
    assert.equal(count(p.seen, 'POST', '/fine_tuning/jobs', afterFirst), 3, 'two model probes and one real attempt');

    // 4. the next attempt reuses both files and tries the job again
    r = await cli(['auto-finetune', '--submit'], h, at(50));
    assert.match(r.out, /复用上次已上传的训练文件：file-1（偏好对未变）/);
    assert.match(r.out, /复用上次已上传的验证文件：file-2/);
    assert.equal(count(p.seen, 'POST', '/files', afterStaged), 0, 'nothing uploaded again');
    assert.equal(count(p.seen, 'POST', '/fine_tuning/jobs', afterStaged), 3, 'probes and one real attempt');

    // 5. the job lands; 6. the cooldown that always existed
    p.mode.upload = 'ok'; p.mode.create = 'ok';
    r = await cli(['auto-finetune', '--submit'], h, at(75));
    assert.match(r.out, /微调任务已创建：job-1（状态 queued）/);
    assert.equal((await ledger(h)).at(-1)!.id, 'job-1');
    const afterSubmit = p.seen.length;
    r = await cli(['auto-finetune', '--submit'], h, at(76));
    assert.match(r.out, /冷却中（上次提交 7 天内）——本次跳过/);
    assert.equal(p.seen.length, afterSubmit, 'not one request');
  } finally {
    await p.close();
    await drop(h);
  }
});

test('auto-finetune: a retired provider is answered with no request; --status still reads the history', { timeout: 10 * 60_000 }, async () => {
  const p = await provider();
  const h = await home(p.url);
  try {
    const retired = new Date('2026-11-27T00:00:00Z').toISOString();
    let r = await cli(['auto-finetune', '--submit'], h, retired);
    assert.equal(r.code, 0, 'a status, not an error');
    assert.match(r.out, /的微调服务已下线（2026-11-16 起），自动微调在这个供应商上不再可用/);
    assert.match(r.out, /dpo-pairs\.jsonl.*原样保留/);
    assert.equal(p.seen.length, 0, 'not one request to a service that is gone');
    assert.deepEqual(await ledger(h).catch(() => []), [], 'nothing to record');

    r = await cli(['auto-finetune', '--status'], h, retired);
    assert.match(r.out, /微调服务已下线/);
    assert.match(r.out, /云端微调任务/, 'the history stays readable while the provider keeps it');
    assert.equal(p.seen.length, 1, 'one read, nothing else');
    assert.equal(p.seen[0]!.method, 'GET');
  } finally {
    await p.close();
    await drop(h);
  }
});

test('auto-finetune: the kill switch refuses a submit before any request', { timeout: 10 * 60_000 }, async () => {
  const p = await provider();
  const h = await home(p.url, { auto: false });
  try {
    const r = await cli(['auto-finetune', '--submit'], h, at(0));
    assert.match(r.out, /自动微调已关闭（config finetune\.auto=false）——本次跳过/);
    assert.equal(p.seen.length, 0, 'not one request');
  } finally {
    await p.close();
    await drop(h);
  }
});
