import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeWorldModel } from '../code-world-model.ts';
import { RUNTIME_FACT_CAP, codeWorldModelPath, loadCodeWorldModel, saveCodeWorldModel } from '../code-world-store.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cog-cwm-store-'));
}

test('store: save → load round-trips all five kinds', async () => {
  const home = await tmpHome();
  const m = new CodeWorldModel();
  m.ingest({
    entities: [{ id: 'file:///a.ts#A', kind: 'class', name: 'A', uri: 'file:///a.ts' }],
    relations: [{ from: 'file:///a.ts', to: 'file:///a.ts#A', kind: 'defines' }],
    diagnostics: [{ uri: 'file:///a.ts', severity: 1, message: 'oops', source: 'lsp' }],
    build: { ok: true, at: '2026-10-04T00:00:00Z' },
    runtime: { kind: 'ext.page.read', detail: 'T — https://a.dev', at: '2026-10-04T00:00:01Z' },
  });
  await saveCodeWorldModel(home, m);
  const back = await loadCodeWorldModel(home);
  assert.equal(back.entityCount, 1);
  assert.equal(back.relationCount, 1);
  assert.equal(back.diagnosticCount, 1);
  assert.ok(back.build?.ok);
  assert.equal(back.runtime.length, 1);
  // file is user-inspectable plain JSON with the kind stamp
  const raw = JSON.parse(await readFile(codeWorldModelPath(home), 'utf8'));
  assert.equal(raw.kind, 'hmharness-code-world');
  assert.equal(raw.version, 1);
  await rm(home, { recursive: true, force: true });
});

test('store: runtime facts TRIMMED to the newest cap at save; in-memory view keeps everything', async () => {
  const home = await tmpHome();
  const m = new CodeWorldModel();
  const total = RUNTIME_FACT_CAP + 60;
  for (let i = 0; i < total; i++) m.ingest({ runtime: { kind: 'ext.page.read', detail: `p${i}`, at: `t${i}` } });
  assert.equal(m.runtime.length, total); // the process's own view is untrimmed
  await saveCodeWorldModel(home, m);
  const back = await loadCodeWorldModel(home);
  assert.equal(back.runtime.length, RUNTIME_FACT_CAP);
  assert.equal(back.runtime[0]!.detail, `p${total - RUNTIME_FACT_CAP}`); // OLDEST beyond the cap dropped
  assert.equal(back.runtime[back.runtime.length - 1]!.detail, `p${total - 1}`); // newest kept
  await rm(home, { recursive: true, force: true });
});

test('store: absent / corrupt / foreign-shaped file loads a FRESH model, never crashes', async () => {
  const home = await tmpHome();
  assert.equal((await loadCodeWorldModel(home)).entityCount, 0); // absent
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(home, 'cognitive'), { recursive: true });
  await writeFile(codeWorldModelPath(home), '{not json', 'utf8');
  assert.equal((await loadCodeWorldModel(home)).entityCount, 0); // corrupt
  await writeFile(codeWorldModelPath(home), JSON.stringify({ kind: 'something-else' }), 'utf8');
  assert.equal((await loadCodeWorldModel(home)).entityCount, 0); // foreign shape
  await rm(home, { recursive: true, force: true });
});

test('model: relation ingest is IDEMPOTENT per edge (re-observation ≠ new fact; dedup survives save→load)', async () => {
  const home = await tmpHome();
  const m = new CodeWorldModel();
  const edge = { from: 'f', to: 'g', kind: 'defines' as const };
  m.ingest({ relations: [edge] });
  m.ingest({ relations: [edge, edge] }); // sensor re-synced the same file
  assert.equal(m.relationCount, 1);
  assert.equal(m.relationsOf('f').length, 1);
  // round-trip keeps dedup: re-ingesting the snapshot's relations adds nothing
  await saveCodeWorldModel(home, m);
  const back = await loadCodeWorldModel(home);
  back.ingest({ relations: back.snapshot().relations });
  assert.equal(back.relationCount, 1);
  await rm(home, { recursive: true, force: true });
});
