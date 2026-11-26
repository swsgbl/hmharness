/**
 * task-runner child × approval mode (2026-11-26, found in the end-to-end pass):
 *
 *   The web UI's mode select is "per-task intent". With the saved config on `auto`, a task
 *   sent with mode "ask" used to run UNATTENDED anyway (the runner only looked at
 *   `payload.yes || cfg.approval === 'auto'`), so the select read "审批询问" while every
 *   tool call went through. An explicit "ask" must ask.
 *
 * Three runs of the real child with a scripted provider that asks for a `run_command`:
 *   1. config auto + explicit ask  -> an approval request is emitted and the run waits
 *   2. config auto + yes          -> unattended (unchanged)
 *   3. config auto + defaulted ask (caller never said "ask") -> unattended (unchanged: API
 *      callers have nobody to answer a dialog)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Ev { kind: string; [k: string]: unknown }

/** A provider that asks the agent to run one command, then answers. */
function scriptedProvider() {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let toolResults = 0;
      try { toolResults = (JSON.parse(body).messages as Array<{ role: string }>).filter((m) => m.role === 'tool').length; } catch { /* no body: step 0 */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
      if (toolResults === 0) {
        send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo hmh-approval-test' }) } }] });
        send({}, 'tool_calls');
      } else {
        send({ content: 'done' }, 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
}

async function runChild(opts: { payload: Record<string, unknown> }): Promise<{ events: Ev[]; code: number }> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-apv-'));
  const fake = scriptedProvider();
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as { port: number }).port;
  await writeFile(join(home, 'config.json'), JSON.stringify({
    providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'sk-x' } },
    routing: { chat: 'fake' },
    approval: 'auto',
  }), 'utf8');
  const payloadFile = join(home, 'payload.json');
  await writeFile(payloadFile, JSON.stringify({ task: 'run it', fresh: true, sessionId: 'apv-test', cwd: home, home, ...opts.payload }), 'utf8');
  const runnerTs = join(import.meta.dirname ?? '.', '..', 'task-runner.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', runnerTs, payloadFile], {
    env: { ...process.env, HMH_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const events: Ev[] = [];
  let buf = '';
  const answered = new Set<number>();
  // answer every approval request as soon as it shows (this is the "user clicks 批准")
  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev: Ev;
      try { ev = JSON.parse(line); } catch { continue; }
      events.push(ev);
      if (ev.kind === 'approvalReq' && !answered.has(Number(ev.id))) {
        answered.add(Number(ev.id));
        child.stdin!.write(JSON.stringify({ type: 'approval', id: Number(ev.id), granted: true }) + '\n');
      }
    }
  });
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(-9); }, 60_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c ?? -1); });
  });
  fake.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  return { events, code };
}

test('explicit "ask" asks even when the saved config says auto (the web UI select is per-task intent)', { timeout: 90_000 }, async () => {
  const { events, code } = await runChild({ payload: { mode: 'ask', yes: false, ask: true } });
  const kinds = events.map((e) => e.kind);
  const reqAt = kinds.indexOf('approvalReq');
  assert.ok(reqAt >= 0, 'an approval request is emitted before the command runs: ' + JSON.stringify(kinds));
  assert.equal(events[reqAt].name, 'run_command');
  assert.ok(kinds.indexOf('approvalDone') > reqAt, 'the run waits for the answer');
  assert.ok(kinds.includes('final') && code === 0, 'granted -> the command runs and the run finishes cleanly');
});

test('control: "auto" (yes) stays unattended with the same config', { timeout: 90_000 }, async () => {
  const { events, code } = await runChild({ payload: { mode: 'auto', yes: true } });
  const kinds = events.map((e) => e.kind);
  assert.ok(!kinds.includes('approvalReq'), 'no dialog for an unattended run: ' + JSON.stringify(kinds));
  assert.ok(kinds.includes('final') && code === 0, 'the command runs straight through');
});

test('compat: a caller that never said "ask" keeps the old behavior under config auto', { timeout: 90_000 }, async () => {
  const { events, code } = await runChild({ payload: { mode: 'ask', yes: false } });
  const kinds = events.map((e) => e.kind);
  assert.ok(!kinds.includes('approvalReq'), 'no explicit ask flag -> unattended as before: ' + JSON.stringify(kinds));
  assert.ok(kinds.includes('final') && code === 0, 'the command runs straight through');
});
