/**
 * forge.test.ts — the forge tool family against a fake CLI seam.
 *
 * gh/ag are faked by node scripts placed FIRST on PATH (`.cmd` shims on
 * Windows — execFile cannot spawn .cmd, which is exactly why forgeRun goes
 * through exec; a POSIX wrapper elsewhere). The fakes dump argv so tests
 * assert exact argument assembly, print canned JSON so renderers run on real
 * shapes, and implement the auth-status flip (3rd call → logged in) that
 * exercises forge_login's polling loop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  forgeDetect, forgeDetectHost, forgeRun, forgeLogin, forgeTools,
  quoteArg, parseAuthStatus, parseJsonOut, renderRepos, renderPrs, renderIssues,
  repoListArgs, repoCreateArgs, prListArgs, prCreateArgs, prMergeArgs, prChecksArgs,
  issueListArgs, issueCreateArgs, releaseCreateArgs, releaseUploadArgs,
} from '../forge.ts';
import type { ToolContext } from '@hmharness/kernel';

const CTX: ToolContext = { cwd: process.cwd(), home: join(tmpdir(), 'forge-test-home') };

// ---------------- pure functions ----------------

test('quoteArg hardens shell metacharacters per platform', () => {
  assert.equal(quoteArg('plain-arg_1.2', 'win32'), 'plain-arg_1.2');
  assert.equal(quoteArg('plain-arg_1.2', 'linux'), 'plain-arg_1.2');
  assert.equal(quoteArg('two words', 'win32'), '"two words"');
  assert.equal(quoteArg('say "hi"', 'win32'), '"say ""hi"""');
  assert.equal(quoteArg('a&b|c', 'win32'), '"a&b|c"');
  assert.equal(quoteArg('', 'win32'), '""');
  assert.equal(quoteArg("it's $HOME", 'linux'), "'it'\\''s $HOME'");
  assert.equal(quoteArg('two words', 'linux'), "'two words'");
  // backslash paths without spaces stay untouched on win32 (cmd passes them raw)
  assert.equal(quoteArg('G:\\dir\\sub', 'win32'), 'G:\\dir\\sub');
});

test('parseAuthStatus reads both CLI phrasings', () => {
  assert.deepEqual(parseAuthStatus('github.com\n  ✓ Logged in to github.com account swsgbl (keyring)'), { loggedIn: true, user: 'swsgbl' });
  assert.deepEqual(parseAuthStatus('✓ Logged in to atomgit.com as demo-user\n  Token: zKxm****1Z3g'), { loggedIn: true, user: 'demo-user' });
  assert.deepEqual(parseAuthStatus('You are not logged into any GitHub hosts. Run gh auth login.'), { loggedIn: false });
  assert.deepEqual(parseAuthStatus(''), { loggedIn: false });
});

test('argument builders: gh field-list JSON + -R selection vs ag positional + boolean JSON', () => {
  assert.deepEqual(repoListArgs('github'), ['repo', 'list', '--limit', '30', '--json', 'name,visibility,updatedAt,pushedAt']);
  assert.deepEqual(repoListArgs('github', 'myorg', 2), ['repo', 'list', 'myorg', '--limit', '60', '--json', 'name,visibility,updatedAt,pushedAt']);
  assert.deepEqual(repoListArgs('atomgit'), ['repo', 'list', '--limit', '30', '--json']);
  assert.deepEqual(repoCreateArgs('github', 'demo', 'private', 'a demo'), ['repo', 'create', 'demo', '--private', '--description', 'a demo']);
  assert.deepEqual(repoCreateArgs('atomgit', 'demo', 'public'), ['repo', 'create', 'demo', '--public']);
  assert.deepEqual(prListArgs('github', 'o/r', 'all'), ['pr', 'list', '-R', 'o/r', '--state', 'all', '--limit', '30', '--json', 'number,title,state,author,headRefName,url']);
  assert.deepEqual(prListArgs('atomgit', 'o/r'), ['pr', 'list', 'o/r', '--state', 'open', '--limit', '30', '--json']);
  assert.deepEqual(prCreateArgs('github', 'o/r', 'feat/x', 'main', 'T', 'B'), ['pr', 'create', '-R', 'o/r', '--head', 'feat/x', '--base', 'main', '--title', 'T', '--body', 'B']);
  assert.deepEqual(prCreateArgs('atomgit', 'o/r', 'feat/x', 'main', 'T'), ['pr', 'create', 'o/r', '--head', 'feat/x', '--base', 'main', '--title', 'T']);
  assert.deepEqual(prMergeArgs('github', 'o/r', '38', 'squash'), ['pr', 'merge', '38', '-R', 'o/r', '--squash']);
  assert.deepEqual(prMergeArgs('github', 'o/r', '38'), ['pr', 'merge', '38', '-R', 'o/r', '--merge']);
  assert.deepEqual(prMergeArgs('atomgit', 'o/r', '38', 'rebase'), ['pr', 'merge', 'o/r', '38', '--rebase']);
  assert.deepEqual(prChecksArgs('github', 'o/r', '38'), ['pr', 'checks', '38', '-R', 'o/r', '--json', 'name,state']);
  assert.deepEqual(prChecksArgs('atomgit', 'o/r', '38'), ['pr', 'checks', 'o/r', '38']);
  assert.deepEqual(issueListArgs('github', 'o/r', 'closed'), ['issue', 'list', '-R', 'o/r', '--state', 'closed', '--limit', '30', '--json', 'number,title,state,author,url']);
  assert.deepEqual(issueCreateArgs('github', 'o/r', 'broken', 'steps'), ['issue', 'create', '-R', 'o/r', '--title', 'broken', '--body', 'steps']);
  // release wire difference: gh --title/--notes vs ag --name/--body (+body required)
  assert.deepEqual(releaseCreateArgs('github', 'o/r', 'v1.0.0', 'One', 'notes', 'main'), ['release', 'create', 'v1.0.0', '-R', 'o/r', '--title', 'One', '--notes', 'notes', '--target', 'main']);
  assert.deepEqual(releaseCreateArgs('atomgit', 'o/r', 'v1.0.0', 'One', 'notes'), ['release', 'create', 'o/r', 'v1.0.0', '--name', 'One', '--body', 'notes']);
  assert.deepEqual(releaseUploadArgs('github', 'o/r', 'v1.0.0', './a.zip'), ['release', 'upload', 'v1.0.0', './a.zip', '-R', 'o/r']);
  assert.deepEqual(releaseUploadArgs('atomgit', 'o/r', 'v1.0.0', './a.zip'), ['release', 'upload', 'o/r', 'v1.0.0', './a.zip']);
});

test('parseJsonOut tolerates banner lines and single objects; rejects garbage', () => {
  assert.equal(parseJsonOut('[{"a":1}]')?.length, 1);
  assert.equal(parseJsonOut('welcome to fake\n[{"a":1},{"b":2}]')?.length, 2);
  assert.equal(parseJsonOut('{"name":"single"}')?.length, 1);
  assert.equal(parseJsonOut('no json here'), null);
});

test('renderers compact gh objects and ag string-typed fields alike', () => {
  const ghRepos = [{ name: 'r1', visibility: 'PRIVATE', updatedAt: '2026-10-01T00:00:00Z', pushedAt: '2026-10-01T01:00:00Z' }];
  assert.match(renderRepos(ghRepos), /^r1 \[private\] updated=2026-10-01T00:00:00Z pushed=2026-10-01T01:00:00Z$/);
  const agRepos = [{ name: 'r2', fullName: 'u/r2', visibility: 'public', updatedAt: '2026-09-01T08:00:00.000+08:00' }];
  assert.match(renderRepos(agRepos), /^r2 \[public\] updated=2026-09-01T08:00:00\.000\+08:00 pushed=n\/a \(host does not report\)$/);
  const ghPrs = [{ number: 38, title: 'fix', state: 'MERGED', author: { login: 'u' }, headRefName: 'fix/x', url: 'https://github.com/o/r/pull/38' }];
  assert.match(renderPrs(ghPrs), /^#38 \[MERGED\] fix — u \(fix\/x\) https:\/\/github\.com\/o\/r\/pull\/38$/);
  const agPrs = [{ number: '169271', title: '优化', state: 'closed', author: 'xin', head: 'b1', url: 'https://atomgit.com/o/r/merge_requests/169271' }];
  assert.match(renderPrs(agPrs), /^#169271 \[closed\] 优化 — xin \(b1\) https:\/\/atomgit\.com/);
  assert.equal(renderIssues([]), '(no issues found)');
});

// ---------------- fake CLI seam ----------------

function fakeCore(bin: string, user: string): string {
  return `
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const dir = __dirname;
fs.appendFileSync(path.join(dir, '${bin}-argv.jsonl'), JSON.stringify(argv) + '\\n');
if (argv[0] === 'auth' && argv[1] === 'status') {
  const cf = path.join(dir, '${bin}-auth-calls');
  const n = fs.existsSync(cf) ? Number(fs.readFileSync(cf, 'utf8')) + 1 : 1;
  fs.writeFileSync(cf, String(n));
  const logged = process.env.FORGE_FAKE_LOGGED_IN === '1' || n >= 3;
  if (logged) { console.log('${bin === 'gh' ? "  ✓ Logged in to github.com account fakeuser (keyring)" : "  ✓ Logged in to atomgit.com as fakeag"}'); process.exit(0); }
  console.error('You are not logged into any hosts. Run ${bin} auth login to authenticate.'); process.exit(1);
}
if (argv[0] === 'auth' && argv[1] === 'login') {
  console.log('First copy your one-time code: ABCD-1234');
  console.log('Open this URL to continue in your web browser: https://${bin === 'gh' ? 'github.com' : 'atomgit.com'}/login/device');
  process.exit(0);
}
if (argv[0] === 'slow') { setTimeout(() => process.exit(0), 5000); return; }
if (argv[0] === 'repo' && argv[1] === 'list') {
  console.log(JSON.stringify(${bin === 'gh'
    ? `[{ name: 'fake-priv', visibility: 'PRIVATE', updatedAt: '2026-10-01T00:00:00Z', pushedAt: '2026-10-01T01:00:00Z' },
      { name: 'fake-pub', visibility: 'PUBLIC', updatedAt: '2026-10-02T00:00:00Z', pushedAt: '2026-10-02T01:00:00Z' }]`
    : `[{ name: 'ag-repo', fullName: 'fakeag/ag-repo', visibility: 'private', updatedAt: '2026-09-01T08:00:00.000+08:00', owner: 'fakeag' }]`}));
  process.exit(0);
}
if (argv[0] === 'pr' && argv[1] === 'list') {
  console.log(JSON.stringify(${bin === 'gh'
    ? `[{ number: 38, title: 'fix transport', state: 'MERGED', author: { login: 'swsgbl' }, headRefName: 'fix/x', url: 'https://github.com/fake/pull/38' }]`
    : `[{ number: '169271', title: '优化生命周期注释', state: 'closed', author: 'xin11112', head: 'cherry-pick', base: 'main', url: 'https://atomgit.com/fake/merge_requests/169271' }]`}));
  process.exit(0);
}
if (argv[0] === 'pr' && argv[1] === 'checks') {
  ${bin === 'gh'
    ? `console.log(JSON.stringify([{ name: 'verify', state: 'SUCCESS' }]));`
    : `console.log('NAME        STATUS    ELAPSED'); console.log('build       pass      1m02s');`};
  process.exit(0);
}
if (argv[0] === 'issue' && argv[1] === 'list') {
  console.log(JSON.stringify([{ number: ${bin === 'gh' ? '7' : "'7'"}, title: 'boom on start', state: 'OPEN', author: ${bin === 'gh' ? "{ login: 'u1' }" : "'u1'"}, url: 'https://${bin === 'gh' ? 'github.com' : 'atomgit.com'}/fake/issues/7' }]));
  process.exit(0);
}
console.log('FAKE-OK ' + argv.join(' '));
`;
}

interface FakeForge {
  dir: string;
  restore(): void;
  /** last argv line the fake saw for this bin */
  lastArgs(bin: string): string[];
}

/** Create gh+ag fakes in a fresh temp dir, prepend them to PATH. */
function installFakes(): FakeForge {
  const dir = mkdtempSync(join(tmpdir(), 'forge-fake-'));
  mkdirSync(dir, { recursive: true });
  for (const bin of ['gh', 'ag']) {
    writeFileSync(join(dir, `${bin}-fake.cjs`), fakeCore(bin, bin === 'gh' ? 'github.com' : 'atomgit.com'));
    if (process.platform === 'win32') {
      // .cmd shim: exec() resolves PATH exactly like the user's cmd shell
      writeFileSync(join(dir, `${bin}.cmd`), `@echo off\r\nnode "%~dp0${bin}-fake.cjs" %*\r\n`);
    } else {
      writeFileSync(join(dir, bin), `#!/bin/sh\nexec node "$(dirname "$0")/${bin}-fake.cjs" "$@"\n`);
      chmodSync(join(dir, bin), 0o755);
    }
  }
  const prevPath = process.env.PATH;
  process.env.PATH = dir + delimiter + prevPath;
  return {
    dir,
    restore() { process.env.PATH = prevPath; },
    lastArgs(bin: string) {
      try { return JSON.parse(readFileSync(join(dir, `${bin}-argv.jsonl`), 'utf8').trim().split('\n').pop() ?? '[]'); }
      catch { return []; }
    },
  };
}

function fakeCtx(): ToolContext { return CTX; }

async function tool(name: string): Promise<{ execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ output: string; isError?: boolean }>; needsApproval?: (a: Record<string, unknown>, c?: ToolContext) => boolean }> {
  const t = forgeTools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} registered`);
  return t as never;
}

// ---------------- detection + tools via the seam ----------------

test('forgeDetect reports install + login for both hosts through the fake seam', async () => {
  const fake = installFakes();
  process.env.FORGE_FAKE_LOGGED_IN = '1';
  try {
    const rows = await forgeDetect();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.host), ['github', 'atomgit']);
    assert.ok(rows.every((r) => r.installed && r.loggedIn));
    assert.equal(rows[0].user, 'fakeuser');
    assert.equal(rows[1].user, 'fakeag');
    const status = await (await tool('forge_status')).execute({}, fakeCtx());
    assert.match(status.output, /github: installed \(gh\), logged in as fakeuser/);
    assert.match(status.output, /atomgit: installed \(ag\), logged in as fakeag/);
    assert.equal(status.isError, undefined);
  } finally {
    delete process.env.FORGE_FAKE_LOGGED_IN;
    fake.restore();
  }
});

test('forge_repo_list (github): exact args, parsed JSON, compact lines', async () => {
  const fake = installFakes();
  process.env.FORGE_FAKE_LOGGED_IN = '1';
  try {
    const r = await (await tool('forge_repo_list')).execute({ host: 'github' }, fakeCtx());
    assert.equal(r.isError, undefined);
    assert.match(r.output, /fake-priv \[private\] updated=2026-10-01T00:00:00Z pushed=2026-10-01T01:00:00Z/);
    assert.match(r.output, /fake-pub \[public\]/);
    assert.deepEqual(fake.lastArgs('gh'), ['repo', 'list', '--limit', '30', '--json', 'name,visibility,updatedAt,pushedAt']);
  } finally {
    delete process.env.FORGE_FAKE_LOGGED_IN;
    fake.restore();
  }
});

test('forge_repo_list (atomgit): boolean --json, honest missing pushedAt', async () => {
  const fake = installFakes();
  process.env.FORGE_FAKE_LOGGED_IN = '1';
  try {
    const r = await (await tool('forge_repo_list')).execute({ host: 'atomgit', owner: 'fakeag', page: 1 }, fakeCtx());
    assert.equal(r.isError, undefined);
    assert.match(r.output, /ag-repo \[private\] updated=2026-09-01T08:00:00\.000\+08:00 pushed=n\/a \(host does not report\)/);
    assert.deepEqual(fake.lastArgs('ag'), ['repo', 'list', 'fakeag', '--limit', '30', '--json']);
  } finally {
    delete process.env.FORGE_FAKE_LOGGED_IN;
    fake.restore();
  }
});

test('forge_pr_list + forge_pr_checks across both hosts', async () => {
  const fake = installFakes();
  process.env.FORGE_FAKE_LOGGED_IN = '1';
  try {
    const prGh = await (await tool('forge_pr_list')).execute({ host: 'github', repo: 'swsgbl/hmharness', state: 'all' }, fakeCtx());
    assert.match(prGh.output, /#38 \[MERGED\] fix transport — swsgbl \(fix\/x\) https:\/\/github\.com\/fake\/pull\/38/);
    const prAg = await (await tool('forge_pr_list')).execute({ host: 'atomgit', repo: 'o/r' }, fakeCtx());
    assert.match(prAg.output, /#169271 \[closed\] 优化生命周期注释 — xin11112 \(cherry-pick\)/);
    const checksGh = await (await tool('forge_pr_checks')).execute({ host: 'github', repo: 'swsgbl/hmharness', num: '38' }, fakeCtx());
    assert.match(checksGh.output, /verify: SUCCESS/);
    const checksAg = await (await tool('forge_pr_checks')).execute({ host: 'atomgit', repo: 'o/r', num: '9' }, fakeCtx());
    assert.match(checksAg.output, /build\s+pass/); // ag human table passed through as-is
  } finally {
    delete process.env.FORGE_FAKE_LOGGED_IN;
    fake.restore();
  }
});

test('write tools pass assembled args through (create/merge/release)', async () => {
  const fake = installFakes();
  process.env.FORGE_FAKE_LOGGED_IN = '1';
  try {
    const mk = await (await tool('forge_repo_create')).execute({ host: 'github', name: 'demo', visibility: 'private', description: 'a demo' }, fakeCtx());
    assert.match(mk.output, /FAKE-OK repo create demo --private --description a demo/);
    assert.deepEqual(fake.lastArgs('gh'), ['repo', 'create', 'demo', '--private', '--description', 'a demo']);
    const pr = await (await tool('forge_pr_create')).execute({ host: 'atomgit', repo: 'o/r', head: 'feat/x', base: 'main', title: 'T it works', body: 'b' }, fakeCtx());
    assert.ok(pr.output.includes('FAKE-OK'), 'pr create hit the fake');
    // spaced title survives as ONE argv entry (quoteArg)
    assert.equal(fake.lastArgs('ag').filter((a) => a === 'T it works').length, 1);
    const rel = await (await tool('forge_release_create')).execute({ host: 'atomgit', repo: 'o/r', tag: 'v1.0.0', name: 'One', body: 'notes text' }, fakeCtx());
    assert.match(rel.output, /FAKE-OK release create o\/r v1\.0\.0 --name One --body notes text/);
    const emptyBody = await (await tool('forge_release_create')).execute({ host: 'github', repo: 'o/r', tag: 'v1', name: 'N', body: '' }, fakeCtx());
    assert.equal(emptyBody.isError, true); // empty release notes refused before the CLI
    // refused locally: the last gh argv the fake saw is the login guard's auth status, not a release
    assert.equal(fake.lastArgs('gh')[0], 'auth');
  } finally {
    delete process.env.FORGE_FAKE_LOGGED_IN;
    fake.restore();
  }
});

test('forge_raw passes arguments through verbatim and is approval-gated', async () => {
  const fake = installFakes();
  process.env.FORGE_FAKE_LOGGED_IN = '1';
  const raw = await tool('forge_raw');
  try {
    assert.equal(raw.needsApproval?.({ host: 'github', args: ['api', 'user'] }, CTX), true);
    const r = await raw.execute({ host: 'github', args: ['api', 'user'] }, fakeCtx());
    assert.match(r.output, /\[gh api user\]/);
    assert.deepEqual(fake.lastArgs('gh'), ['api', 'user']);
    const bad = await raw.execute({ host: 'github' }, fakeCtx());
    assert.equal(bad.isError, true);
    const badHost = await raw.execute({ host: 'gitlab', args: ['x'] }, fakeCtx());
    assert.match(badHost.output, /host must be 'github' or 'atomgit'/);
  } finally {
    delete process.env.FORGE_FAKE_LOGGED_IN;
    fake.restore();
  }
});

test('not logged in → honest login guidance, no CLI call', async () => {
  const fake = installFakes(); // fresh dir: auth counter at 1, FORGE_FAKE_LOGGED_IN unset
  try {
    const r = await (await tool('forge_repo_list')).execute({ host: 'github' }, fakeCtx());
    assert.equal(r.isError, true);
    assert.match(r.output, /Not logged in to github/);
    assert.match(r.output, /forge_login/);
    assert.match(r.output, /`gh auth login`/);
    // the list command itself never ran
    assert.ok(!fake.lastArgs('gh').includes('list'));
  } finally {
    fake.restore();
  }
});

test('not installed → honest install hint (winget / npm) without shell mojibake', async () => {
  // strip fake+real forge dirs from PATH, keep the shell itself alive
  const keep = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin';
  const prevPath = process.env.PATH;
  process.env.PATH = keep;
  try {
    const gh = await forgeDetectHost('github');
    assert.equal(gh.installed, false);
    const status = await (await tool('forge_status')).execute({}, fakeCtx());
    assert.match(status.output, /github: NOT installed — .*winget install GitHub\.cli/);
    assert.match(status.output, /atomgit: NOT installed — .*npm install -g @hust-open-atom-club\/atomgit-cli/);
    const r = await forgeRun('github', ['repo', 'list']);
    assert.equal(r.ok, false);
    assert.match(r.output, /gh \(GitHub CLI\) is not installed/);
  } finally {
    process.env.PATH = prevPath;
  }
});

test('forgeRun times out honestly', async () => {
  const fake = installFakes();
  process.env.FORGE_FAKE_LOGGED_IN = '1';
  try {
    const r = await forgeRun('github', ['slow'], { timeoutMs: 800 });
    assert.equal(r.ok, false);
    assert.match(r.output, /timed out after 800ms/);
  } finally {
    delete process.env.FORGE_FAKE_LOGGED_IN;
    fake.restore();
  }
});

test('forge_login polls the flip (3rd auth status call) and reports the device code', async () => {
  const fake = installFakes(); // auth status: call 1 not logged in, call 3 logged in
  try {
    const r = await forgeLogin('github', { pollMs: 80, timeoutMs: 20_000 });
    assert.equal(r.isError, undefined, r.output);
    assert.match(r.output, /login complete: github as fakeuser/);
    assert.match(r.output, /device code: ABCD-1234/);
    assert.match(r.output, /github\.com\/login\/device/);
    // the web-login subprocess was really started with gh's device-flow flags
    const dump = readFileSync(join(fake.dir, 'gh-argv.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(dump.some((a) => a[0] === 'auth' && a[1] === 'login' && a.includes('--web') && a.includes('-h') && a.includes('github.com') && a.includes('--skip-ssh-key')));
    // already-logged-in short-circuit
    const again = await forgeLogin('github', { pollMs: 80, timeoutMs: 1_000 });
    assert.match(again.output, /already logged in to github as fakeuser/);
  } finally {
    fake.restore();
  }
});

test('forge tool family: 13 tools; every write gated, reads and login free', () => {
  const names = forgeTools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'forge_issue_create', 'forge_issue_list', 'forge_login', 'forge_pr_checks', 'forge_pr_create',
    'forge_pr_list', 'forge_pr_merge', 'forge_raw', 'forge_release_create', 'forge_release_upload',
    'forge_repo_create', 'forge_repo_list', 'forge_status',
  ]);
  const WRITES = new Set(['forge_repo_create', 'forge_pr_create', 'forge_pr_merge', 'forge_issue_create', 'forge_release_create', 'forge_release_upload', 'forge_raw']);
  for (const t of forgeTools) {
    const gated = t.needsApproval?.({}, CTX) === true;
    assert.equal(gated, WRITES.has(t.name), `${t.name} gating (writes must ask, reads must not)`);
  }
});

// keep tmp scratch honest: the seam dirs are left for post-mortem inspection
// only within the OS temp root; nothing is written into the repo.
void appendFileSync; void mkdirSync; void writeFileSync; void rmSync;
