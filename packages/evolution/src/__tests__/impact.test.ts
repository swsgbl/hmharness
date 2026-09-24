import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionGetsCanary, canaryWatermark, readBudget, recordParetoEntry, readParetoEntries, sampleAncestor, impactReport, decayUnusedSkills } from '../impact.ts';
import { listCanary, listSkills, pinSkill, unpinSkill, promoteSkill, writeDraft, promoteCanary, retireCanary, listDrafts } from '../skills.ts';
import { findWorkflowClusters } from '../workflows.ts';
import type { Insight } from '../insights.ts';

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-impact-'));
  for (const d of ['insights', 'skills/draft', 'skills/active', 'skills/canary', 'skills/archive', 'evolution/pareto']) {
    await mkdir(join(home, d), { recursive: true });
  }
  return home;
}

async function seedInsights(home: string, list: Array<{ ok: boolean; skills: string[]; time?: string }>): Promise<void> {
  const lines = list.map((x, n) => JSON.stringify({
    time: x.time ?? new Date(Date.now() - (list.length - n) * 60_000).toISOString(),
    session: `s${n}`, task: `task ${n}`, outcome: x.ok ? 'ok' : 'error',
    turns: 3, toolUses: 2, toolsUsed: ['read_file'], skillsInjected: x.skills,
  } satisfies Insight));
  await writeFile(join(home, 'insights', 'insights.jsonl'), lines.join('\n') + '\n', 'utf8');
}

test('canary sampling: deterministic per session, ~20% across a population', () => {
  // same session -> same verdict (stable attribution)
  assert.equal(sessionGetsCanary('abc'), sessionGetsCanary('abc'));
  assert.equal(sessionGetsCanary('xyz'), sessionGetsCanary('xyz'));
  // ~20% of a deterministic population (allow slack; it's a hash, not RNG)
  let hit = 0;
  for (let i = 0; i < 1000; i++) if (sessionGetsCanary(`sess-${i}`)) hit++;
  assert.ok(hit >= 120 && hit <= 280, `expected ~200, got ${hit}`);
});

test('canary watermark states references-not-rules (Misevolve mitigation)', () => {
  const w = canaryWatermark(['fix-build-workflow']);
  assert.match(w, /experimental/i);
  assert.match(w, /references to weigh/i);
  assert.equal(canaryWatermark([]), '');
});

test('budget gate: reads config cap and counts today cycles from log', async () => {
  const home = await freshHome();
  let b = await readBudget(home);
  assert.equal(b.cyclesToday, 0);
  assert.equal(b.maxCyclesPerDay, undefined);
  await writeFile(join(home, 'config.json'), JSON.stringify({ evolutionBudget: { maxCyclesPerDay: 3 } }), 'utf8');
  await writeFile(join(home, 'evolution', 'log.jsonl'), JSON.stringify({ time: new Date().toISOString() }) + '\n', 'utf8');
  b = await readBudget(home);
  assert.equal(b.maxCyclesPerDay, 3);
  assert.equal(b.cyclesToday, 1);
  await rm(home, { recursive: true, force: true });
});

test('pareto archive: rejected candidates persist, one ancestor sampled, merge crosses complementary failures', async () => {
  const home = await freshHome();
  await recordParetoEntry(home, { name: 'a', parentInsights: [], rejectedReason: 'too generic', scores: { train: 0.3 }, metaModel: 'm', at: 't1', skillMd: '# a' });
  await recordParetoEntry(home, { name: 'b', parentInsights: [], rejectedReason: 'too narrow', scores: { train: 0.2 }, metaModel: 'm', at: 't2', skillMd: '# b' });
  const entries = await readParetoEntries(home);
  assert.equal(entries.length, 2);
  const { ancestor } = sampleAncestor(entries);
  assert.ok(ancestor && ['a', 'b'].includes(ancestor.name));
  // complementary rejection reasons enable merge crossing
  let sawMerge = false;
  for (let i = 0; i < 50; i++) { if (sampleAncestor(entries).mergeWith) sawMerge = true; }
  assert.equal(sawMerge, true);
  await rm(home, { recursive: true, force: true });
});

test('canary promotion path: draft -> canary -> (impact promote) active; retire returns to draft, nothing deleted', async () => {
  const home = await freshHome();
  await writeDraft(home, 'demo-skill', '# demo\nA skill.');
  const promoted = await promoteSkill(home, 'demo-skill', { canary: true });
  assert.match(promoted.file, /canary[\\/]demo-skill/);
  assert.deepEqual((await listCanary(home)).map((s) => s.name), ['demo-skill']);
  // graduate
  assert.equal(await promoteCanary(home, 'demo-skill'), true);
  assert.equal((await listSkills(home)).some((s) => s.name === 'demo-skill'), true);
  assert.equal((await listCanary(home)).length, 0);
  // retire path on a second canary
  await writeDraft(home, 'bad-skill', '# bad\nB.');
  await promoteSkill(home, 'bad-skill', { canary: true });
  assert.equal(await retireCanary(home, 'bad-skill'), true);
  assert.equal((await listDrafts(home)).some((s) => s.name === 'bad-skill'), true);
  await rm(home, { recursive: true, force: true });
});

test('impact report: promotes only on >=10% edge with >=8 sessions each, retires on harm, honest when thin', async () => {
  const home = await freshHome();
  // skill A: exposed 10 sessions, 90% ok; control 10 sessions, 50% ok -> promote
  const mk = (n: number, ok: boolean, skills: string[]) => Array.from({ length: n }, () => ({ ok, skills }));
  await seedInsights(home, [
    ...mk(9, true, ['A']), ...mk(1, false, ['A']),
    ...mk(5, true, []), ...mk(5, false, []),
  ]);
  await writeDraft(home, 'A', '# a\nX.');
  await promoteSkill(home, 'A', { canary: true });
  const { rows, applied } = await impactReport(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, 'promote');
  assert.match(applied.join('\n'), /promoted to active: A/);
  assert.equal((await listCanary(home)).length, 0);
  await rm(home, { recursive: true, force: true });
});

test('impact verdict insufficient-data below the evidence floor', async () => {
  const home = await freshHome();
  await seedInsights(home, [{ ok: true, skills: ['A'] }, { ok: false, skills: [] }]);
  await writeDraft(home, 'A', '# a\nX.');
  await promoteSkill(home, 'A', { canary: true });
  const { rows } = await impactReport(home);
  assert.equal(rows[0].verdict, 'insufficient-data');
  await rm(home, { recursive: true, force: true });
});

test('pin: pinned skills survive decay; unpinned go dormant after 30 quiet days', async () => {
  const home = await freshHome();
  const old = new Date(Date.now() - 40 * 86400_000).toISOString();
  await seedInsights(home, [
    { ok: true, skills: ['old-pinned'], time: old },
    { ok: true, skills: ['old-fading'], time: old },
  ]);
  // active skills on disk
  for (const name of ['old-pinned', 'old-fading', 'fresh']) {
    await mkdir(join(home, 'skills', 'active', name), { recursive: true });
    await writeFile(join(home, 'skills', 'active', name, 'SKILL.md'), `# ${name}\nD.`, 'utf8');
  }
  await pinSkill(home, 'old-pinned');
  const moved = await decayUnusedSkills(home, 30);
  assert.ok(moved.includes('old-fading'), `expected old-fading dormant, got ${moved}`);
  assert.equal(moved.includes('old-pinned'), false);
  assert.equal(moved.includes('fresh'), false); // fresh = never-injected AND <50 insights
  // pinned marker visible; unpin works
  const pinnedFile = join(home, 'skills', 'active', 'old-pinned', 'SKILL.md');
  assert.equal(await (await import('../skills.ts')).isPinned(pinnedFile), true);
  assert.equal(await unpinSkill(home, 'old-pinned'), true);
  await rm(home, { recursive: true, force: true });
});

test('AWM clusters: repeated task archetypes surface as workflow candidates', async () => {
  const home = await freshHome();
  await seedInsights(home, [
    { ok: true, skills: [] }, { ok: true, skills: [] }, { ok: true, skills: [] },
  ]);
  // rewrite with same-archetype tasks
  const arch = Array.from({ length: 3 }, (_, n) => JSON.stringify({
    time: new Date().toISOString(), session: `w${n}`,
    task: 'fix build error in module entry', outcome: 'ok',
    turns: 2, toolUses: 1, toolsUsed: [], skillsInjected: [],
  }));
  await writeFile(join(home, 'insights', 'insights.jsonl'), arch.join('\n') + '\n', 'utf8');
  const clusters = await findWorkflowClusters(home, 3);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].tasks.length, 3);
  await rm(home, { recursive: true, force: true });
});
