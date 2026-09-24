import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  attachRun, checkpointProject, createProject, findProject, interruptProject,
  listProjects, loadProject, projectFor, releaseProject, restoreCheckpoint,
  resumeBundle, transitionProject,
} from '../project.ts';

const run = promisify(execFile);
const sh = async (cmd: string, args: string[], cwd: string) => {
  try { return (await run(cmd, args, { cwd, windowsHide: true })).stdout.trim(); } catch { return ''; }
};

test('lifecycle: created→active→paused→active→completed→archived, illegal jumps rejected', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-proj-'));
  try {
    let rec = await createProject(home, 'G:/nowhere');
    assert.equal(rec.state, 'created');
    await assert.rejects(() => transitionProject(home, rec, 'paused'), /illegal transition created -> paused/);
    rec = await transitionProject(home, rec, 'active');
    rec = await interruptProject(home, rec, 'user hit stop');
    assert.equal(rec.state, 'paused', 'interrupt pauses (resumable)');
    rec = await transitionProject(home, rec, 'active');
    rec = await transitionProject(home, rec, 'completed');
    rec = await transitionProject(home, rec, 'archived');
    await assert.rejects(() => checkpointProject(home, rec, 'late'), /archived projects cannot/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('projectFor: find-or-create, newest non-archived wins, path matching is case/slash tolerant', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-proj2-'));
  try {
    const ws = await mkdtemp(join(tmpdir(), 'hmh-ws-'));
    const a = await projectFor(home, ws);
    assert.equal(a.state, 'active');
    const again = await projectFor(home, ws.replace(/\//g, '\\'));
    assert.equal(again.projectId, a.projectId, 'same project rediscovered');
    assert.equal((await listProjects(home)).length, 1);
    await rm(ws, { recursive: true, force: true });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('git checkpoint: tree snapshot without touching user index/refs/worktree', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-proj3-'));
  const ws = await mkdtemp(join(tmpdir(), 'hmh-ws3-'));
  try {
    await sh('git', ['init', '-q'], ws);
    await sh('git', ['config', 'user.email', 't@t'], ws);
    await sh('git', ['config', 'user.name', 't'], ws);
    await writeFile(join(ws, 'committed.txt'), 'v1\n', 'utf8');
    await sh('git', ['add', '-A'], ws);
    await sh('git', ['commit', '-qm', 'init'], ws);
    const rec = await projectFor(home, ws);
    await writeFile(join(ws, 'committed.txt'), 'v2 UNCOMMITTED\n', 'utf8');
    await writeFile(join(ws, 'untracked.txt'), 'brand new\n', 'utf8');
    const headBefore = await sh('git', ['rev-parse', 'HEAD'], ws);
    const statusBefore = await sh('git', ['status', '--porcelain'], ws);
    const refsBefore = await sh('git', ['for-each-ref'], ws);

    const cp = await checkpointProject(home, rec, 'before risk');

    assert.match(cp.tree, /^[0-9a-f]{40}$/, 'real tree object');
    assert.equal(cp.files, 2, 'committed (modified) + untracked both captured');
    // user tree untouched: same HEAD, same dirty status, no NEW refs (objects only)
    assert.equal(await sh('git', ['rev-parse', 'HEAD'], ws), headBefore);
    assert.equal(await sh('git', ['status', '--porcelain'], ws), statusBefore);
    assert.equal(await sh('git', ['for-each-ref'], ws), refsBefore, 'no refs created (objects only)');
    // archive materialization restores BOTH files byte-exact into a sandbox copy
    // (line-ending agnostic: autocrlf may normalize on the way into the object)
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    const session = await restoreCheckpoint(home, rec, cp.id);
    const restored = await readFile(join(session.dir, 'committed.txt'), 'utf8');
    assert.equal(norm(restored), 'v2 UNCOMMITTED\n');
    assert.equal(norm(await readFile(join(session.dir, 'untracked.txt'), 'utf8')), 'brand new\n');
    // and the user's workspace still holds its live state
    assert.equal(norm(await readFile(join(ws, 'committed.txt'), 'utf8')), 'v2 UNCOMMITTED\n');
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  }
});

test('non-git workspace: copy fallback checkpoint + restore', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-proj4-'));
  const ws = await mkdtemp(join(tmpdir(), 'hmh-ws4-'));
  try {
    await writeFile(join(ws, 'plain.txt'), 'hello\n', 'utf8');
    await mkdir(join(ws, 'node_modules'), { recursive: true });
    await writeFile(join(ws, 'node_modules', 'junk.txt'), 'skip me\n', 'utf8');
    const rec = await projectFor(home, ws);
    const cp = await checkpointProject(home, rec);
    assert.match(cp.tree, /^copy:/);
    assert.equal(cp.files, 1, 'node_modules skipped');
    const session = await restoreCheckpoint(home, rec, cp.id);
    assert.equal(await readFile(join(session.dir, 'plain.txt'), 'utf8'), 'hello\n');
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  }
});

test('run continuation: attachRun + resumeBundle + release versioning', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-proj5-'));
  const ws = await mkdtemp(join(tmpdir(), 'hmh-ws5-'));
  try {
    const rec = await projectFor(home, ws);
    await attachRun(home, rec, '2026-09-13T10-00-00-abc123');
    const cp = await checkpointProject(home, rec, 'after first run');
    await attachRun(home, rec, '2026-09-13T11-00-00-def456');
    const saved = await loadProject(home, rec.projectId);
    assert.ok(saved);
    const bundle = await resumeBundle(home, saved!);
    assert.equal(bundle.lastRun, '2026-09-13T11-00-00-def456');
    assert.equal(bundle.lastCheckpoint!.id, cp.id);
    await releaseProject(home, saved!, 'v1.0.0', 'first cut');
    const rel = (await loadProject(home, rec.projectId))!.releases[0];
    assert.equal(rel.version, 'v1.0.0');
    assert.equal(rel.checkpointId, cp.id, 'release pinned to its checkpoint');
    // decisions mirror exists as jsonl
    const mirror = await readFile(join(home, 'projects', rec.projectId, 'decisions.jsonl'), 'utf8');
    assert.ok(mirror.includes('"kind":"checkpoint"'));
    assert.ok(mirror.includes('"kind":"release"'));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  }
});
