import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDataset, filterFingerprint, listDatasets, loadDataset, rewardFor, splitFor, type DatasetSample } from '../dataset.ts';

const summary = (over: Record<string, unknown> = {}) => JSON.stringify({
  task: 'build the app', outcome: 'ok', turns: 3, toolUses: 4, toolFailures: 0,
  toolsUsed: ['list_dir', 'run_command'], model: 'm', ...over,
});

async function seedRuns(home: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const dir = join(home, 'runs', `2026-09-13T10-00-${String(i).padStart(2, '0')}-r${i}`);
    await mkdir(dir, { recursive: true });
    // i % 3 == 0 -> failing run with tool errors; duplicate pairs for i in {1,2}
    const over = i % 3 === 0
      ? { outcome: 'error', turns: 2, toolUses: 3, toolFailures: 3 }
      : { task: i === 2 ? 'build the app' : `task variant ${i}`, toolFailures: i === 1 ? 1 : 0 };
    await writeFile(join(dir, 'summary.json'), summary(over), 'utf8');
  }
  // a torn run without summary - must be ignored
  await mkdir(join(home, 'runs', '2026-09-13T10-00-99-torn'), { recursive: true });
}

test('rewardFor: interpretable mapping, llm-judge cap', () => {
  assert.equal(rewardFor('ok', 0), 1.0);
  assert.equal(rewardFor('ok', 0.2), 0.8, 'lose 0.1 per 10% tool failures');
  assert.equal(rewardFor('ok', 0.9), 0.4, 'deduction capped at 0.6');
  assert.ok(rewardFor('error', 1) <= 0.3);
  assert.ok(rewardFor('turn-budget', 0) <= 0.3);
  // evidence rank >=5 (llmJudge) caps at 0.7 - never a free perfect
  assert.equal(rewardFor('ok', 0, 5), 0.7);
  assert.equal(rewardFor('ok', 0, 8), 0.7);
});

test('splitFor: deterministic, both halves reachable', () => {
  const a = splitFor('run-x', 42);
  assert.equal(a, splitFor('run-x', 42));
  const halves = new Set(Array.from({ length: 40 }, (_, i) => splitFor(`run-${i}`, 42)));
  assert.ok(halves.has('train') && halves.has('eval'), 'both halves populated over a spread of ids');
});

test('buildDataset: filter, dedupe, redact, split, manifest', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-ds-'));
  try {
    await seedRuns(home);
    const r = await buildDataset(home, { version: 'v-test' });
    assert.equal(r.manifest.counts.scanned, 12, 'torn run (no summary) never enters the scan');
    assert.equal(r.manifest.counts.dropped, 0);
    assert.equal(r.manifest.counts.duplicates, 3, 'identical failing reruns deduped (same task/outcome/turns/tools)');
    assert.equal(r.manifest.counts.kept, 9);
    assert.ok(r.manifest.counts.train > 0 && r.manifest.counts.eval > 0, 'both splits populated');
    assert.equal(r.manifest.counts.train + r.manifest.counts.eval, r.manifest.counts.kept);
    assert.equal(r.manifest.filterFingerprint, filterFingerprint({}));
    const samples = await loadDataset(home, 'v-test');
    assert.equal(samples.length, 9);
    const err = samples.find((s) => s.outcome === 'error');
    assert.ok(err);
    assert.ok(err.reward <= 0.3, 'error runs capped');
    assert.ok(samples.every((s) => s.reward >= 0 && s.reward <= 1));
    // samples.jsonl on disk, manifest reproducible
    const raw = await readFile(join(r.dir, 'samples.jsonl'), 'utf8');
    const first = JSON.parse(raw.split('\n')[0]) as DatasetSample;
    assert.ok(first.runId && typeof first.reward === 'number');
    // rebuild with same options -> same fingerprint and same split for a given run
    const r2 = await buildDataset(home, { version: 'v-test2' });
    const s1 = (await loadDataset(home, 'v-test')).find((s) => s.runId === '2026-09-13T10-00-01-r1');
    const s2 = (await loadDataset(home, 'v-test2')).find((s) => s.runId === '2026-09-13T10-00-01-r1');
    assert.equal(s1!.split, s2!.split, 'split is deterministic per run');
    assert.equal((await listDatasets(home)).length, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('buildDataset: secrets in task text are redacted on export', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-ds2-'));
  try {
    const dir = join(home, 'runs', 'r1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'summary.json'), JSON.stringify({
      task: `add provider sk-${'A'.repeat(30)} to config`, outcome: 'ok', turns: 1, toolUses: 1, toolFailures: 0, toolsUsed: ['write_file'], model: 'm',
    }), 'utf8');
    const r = await buildDataset(home, { version: 'v-redact' });
    const raw = await readFile(join(r.dir, 'samples.jsonl'), 'utf8');
    assert.ok(!raw.includes('A'.repeat(30)), 'secret absent');
    assert.ok(raw.includes('sk-[REDACTED]'));
  } finally { await rm(home, { recursive: true, force: true }); }
});
