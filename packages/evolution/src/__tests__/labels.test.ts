import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { labelSession, readLabels, labelableSessions } from '../labels.ts';

const sid = '2026-09-14T08-00-00-abc123';

test('labelSession: validates, dedupes by session, persists to reward-human-labels.jsonl', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-label-'));
  try {
    assert.equal((await labelSession(home, 'not-a-session', 3)).ok, false);
    assert.equal((await labelSession(home, sid, 9)).ok, false, 'score out of range');
    const r1 = await labelSession(home, sid, 4, 'solid build');
    assert.equal(r1.ok, true);
    assert.equal(r1.count, 1);
    // first label wins
    const dup = await labelSession(home, sid, 2);
    assert.equal(dup.ok, false);
    assert.match(dup.reason!, /already labeled/);
    const labels = await readLabels(home);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].score, 4);
    assert.equal(labels[0].note, 'solid build');
    const raw = await readFile(join(home, 'evolution', 'reward-human-labels.jsonl'), 'utf8');
    assert.ok(raw.includes(sid));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('labelableSessions: surfaces unlabeled sessions from the insight feed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-label2-'));
  try {
    await mkdir(join(home, 'insights'), { recursive: true });
    await writeFile(join(home, 'insights', 'insights.jsonl'), [
      JSON.stringify({ time: '2026-09-14T07:00:00Z', session: '2026-09-14T07-00-00-s1', task: 'build the app', outcome: 'ok', turns: 2, toolUses: 1, toolsUsed: ['harmony_build'] }),
      JSON.stringify({ time: '2026-09-14T07:05:00Z', session: '2026-09-14T07-05-00-s2', task: 'run device test', outcome: 'error', turns: 3, toolUses: 2, toolsUsed: ['run_command'] }),
    ].join('\n') + '\n', 'utf8');
    const rows = await labelableSessions(home);
    assert.ok(rows.some((r) => r.session === '2026-09-14T07-00-00-s1' && r.task.includes('build')));
    assert.ok(rows.some((r) => r.session === '2026-09-14T07-05-00-s2'));
    // after labeling, the labeled session drops out of the unlabeled pool
    await labelSession(home, '2026-09-14T07-00-00-s1', 5);
    const after = await labelableSessions(home);
    assert.ok(!after.some((r) => r.session === '2026-09-14T07-00-00-s1' && !r.label));
  } finally { await rm(home, { recursive: true, force: true }); }
});
