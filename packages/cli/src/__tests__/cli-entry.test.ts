/**
 * The CLI entry, as a user meets it (2026-11-26). Each case starts the real
 * `main.ts` in a child process against a temporary HMH_HOME, so nothing here
 * reads or writes the user's own home - and none of these commands talks to a
 * daemon, so nothing here can stop one either (see daemon-stop-safety.test.ts
 * for why `web stop` itself is deliberately not run by a test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../main.ts', import.meta.url));
/** The version `hmh --version` must print - read from the package under test, never a literal.
 *  A literal ('0.23.53') shipped with the first 0.23.54 tag: green on the PR, where the version
 *  still was 0.23.53, and red on the release commit, where the bump had changed it - the
 *  publish gate refused the release (2026-11-26). Same file main.ts reads (one level up from here). */
const PACKAGE_VERSION = (createRequire(import.meta.url)('../../package.json') as { version?: string }).version;

function cli(args: string[], home: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', MAIN, ...args], {
      env: { ...process.env, HMH_HOME: home, HMH_LOCALE: 'zh' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const take = (sink: (d: Buffer) => void) => (d: Buffer) => sink(d);
    child.stdout!.on('data', take((d) => (out += d.toString())));
    child.stderr!.on('data', take((d) => (err += d.toString())));
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-cli-'));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test('hmh --version (and -v, version) prints the version and exits 0 - it used to open the interactive REPL', async () => {
  assert.match(PACKAGE_VERSION ?? '', /^\d+\.\d+\.\d+$/, 'precondition: the package under test carries a real version');
  await withHome(async (home) => {
    for (const flag of ['--version', '-v', '-V', 'version']) {
      const r = await cli([flag], home);
      assert.equal(r.code, 0, `${flag}: exit code (stderr: ${r.err.slice(0, 200)})`);
      assert.equal(r.out.trim(), 'hmh ' + PACKAGE_VERSION, `${flag}: one line, the version of the package under test`);
    }
  });
});

test('an unknown option is refused with a hint and exit code 2 - it used to fall into the REPL', async () => {
  await withHome(async (home) => {
    const r = await cli(['--no-such-flag'], home);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown option --no-such-flag/);
    assert.match(r.err, /hmh --help/);
    assert.equal(r.out, '', 'nothing else is printed, nothing is started');
  });
});

test('hmh --help lists the version flag', async () => {
  await withHome(async (home) => {
    const r = await cli(['--help'], home);
    assert.equal(r.code, 0);
    assert.match(r.out, /--version \| -v/);
  });
});

test('hmh reward train-prep <dir> exports into the named directory (with a directory argument it died on ReferenceError: `require` in an ESM module)', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, 'evolution'), { recursive: true });
    await writeFile(join(home, 'evolution', 'dpo-pairs.jsonl'), [
      JSON.stringify({ prompt: 'p1', chosen: 'good', rejected: 'bad', split: 'train' }),
      JSON.stringify({ prompt: 'p2', chosen: 'g2', rejected: 'b2', split: 'eval' }),
    ].join('\n') + '\n', 'utf8');
    const out = join(home, 'trainer-ready');
    const r = await cli(['reward', 'train-prep', out], home);
    assert.equal(r.code, 0, `exit code (stderr: ${r.err.slice(0, 200)})`);
    assert.doesNotMatch(r.out + r.err, /ReferenceError/);
    assert.deepEqual((await readdir(out)).sort(), ['dataset_info.json', 'dpo-eval.jsonl', 'dpo-train.jsonl']);
    assert.equal((await readFile(join(out, 'dpo-train.jsonl'), 'utf8')).trim().split('\n').length, 1);
  });
});
