/**
 * The REPL, as a user drives it: the real `main.ts` in a child process, piped
 * stdin, a scripted model. Two lines in one sitting - the second must be
 * answered with the first one's work in view (2026-11-26: for two months the
 * thread carried only the user's lines, so every line started from scratch).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scriptedModel, requestsFor, text, until } from './scripted-model.ts';

// the entry under test: the source tree by default; HMH_TEST_MAIN points it at an
// installed build (how the negative control runs this very test against a released version)
const MAIN = process.env.HMH_TEST_MAIN ?? fileURLToPath(new URL('../main.ts', import.meta.url));

function repl(home: string): ChildProcess {
  const loader = MAIN.endsWith('.ts') ? ['--import', 'tsx'] : [];
  return spawn(process.execPath, [...loader, MAIN], {
    env: { ...process.env, HMH_HOME: home, HMH_LOCALE: 'zh' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

test('REPL: the second line of a sitting is answered with the first line\'s answer in view', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-repl-conv-'));
  const empty = join(home, 'empty-dir');
  await mkdir(empty);
  const model = await scriptedModel(empty);
  // the background auto-update is OFF for this home: a test must never touch the global install
  await writeFile(join(home, 'config.json'), JSON.stringify({
    tui: { autoUpdate: false },
    approval: 'auto',
    provider: { baseUrl: model.url, apiKey: 'k', model: 'm' },
  }), 'utf8');
  const child = repl(home);
  let out = '';
  child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  try {
    assert.ok(await until('the REPL is up', () => /hmh>/.test(out)), 'the REPL prompt appeared');
    child.stdin!.write('first\n');
    assert.ok(await until('the first line is answered', () => requestsFor(model, 'first').length >= 2), 'two model requests for the first line');
    child.stdin!.write('second\n');
    assert.ok(await until('the second line reaches the model', () => requestsFor(model, 'second').length >= 1), 'the model was asked about the second line');
    const req = requestsFor(model, 'second')[0]!.messages;
    const from = req.findIndex((m) => m.role === 'user' && text(m) === 'first');
    assert.ok(from >= 0, 'the first line is still in view');
    const carried = req.slice(from);
    assert.deepEqual(carried.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'user'], 'first line, the tool call, its result, the answer, then the second line');
    assert.equal(text(carried[3]), 'DONE turn 1', 'the answer to the first line is what the model sees before the second');
    assert.ok(out.includes('DONE turn 1'), 'and the user saw it');
  } finally {
    try { child.stdin!.end('/exit\n'); } catch { /* gone */ }
    const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 8_000))]);
    if (code === null) child.kill();
    await model.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
