import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeWorldModel, type CodeEntity, type SymbolRelation } from '../code-world-model.ts';

const F = 'file:///src/a.ts';
const G = 'file:///src/b.ts';
const main: CodeEntity = { id: `${F}#main`, kind: 'function', name: 'main', uri: F, range: { startLine: 1, endLine: 10 } };
const helper: CodeEntity = { id: `${F}#helper`, kind: 'function', name: 'helper', uri: F, range: { startLine: 12, endLine: 20 } };
const caller: CodeEntity = { id: `${G}#caller`, kind: 'function', name: 'caller', uri: G };
const rels: SymbolRelation[] = [
  { from: caller.id, to: main.id, kind: 'calls' },
  { from: main.id, to: helper.id, kind: 'calls' },
];

test('cwm: ingest unifies the five fact kinds and answers graph queries', () => {
  const cwm = new CodeWorldModel();
  cwm.ingest({
    entities: [main, helper, caller],
    relations: rels,
    diagnostics: [{ uri: F, severity: 1, message: 'missing semicolon', source: 'lsp' }],
    build: { ok: true, at: '2026-10-04T00:00:00Z' },
    runtime: { kind: 'smoke', detail: 'exit 0', at: '2026-10-04T00:01:00Z' },
  });
  assert.equal(cwm.entityCount, 3);
  assert.equal(cwm.relationCount, 2);
  assert.equal(cwm.diagnosticCount, 1);
  assert.equal(cwm.build?.ok, true);
  assert.deepEqual(cwm.relationsOf(main.id).map((r) => r.kind).sort(), ['calls', 'calls']);
  assert.equal(cwm.diagnosticsFor(F)[0]?.source, 'lsp');
  // diagnostics overwrite per uri (sensor pushes fresh state)
  cwm.ingest({ diagnostics: [{ uri: F, severity: 2, message: 'unused var', source: 'lsp' }] });
  assert.equal(cwm.diagnosticsFor(F).length, 2, 'distinct messages accumulate');
  cwm.ingest({ diagnostics: [{ uri: F, severity: 2, message: 'unused var', source: 'lsp' }] });
  assert.equal(cwm.diagnosticsFor(F).length, 2, 'same message+source replaces, no dupes');
});

test('cwm: rename prediction covers the graph blast radius; perfect actual = zero error', () => {
  const cwm = new CodeWorldModel();
  cwm.ingest({ entities: [main, helper, caller], relations: rels, diagnostics: [{ uri: F, severity: 1, message: 'x', source: 'lsp' }] });
  const p = cwm.predictEditDelta({ editKind: 'rename', target: main.id });
  // prediction: main itself + every relation naming main -> caller and helper dragged in
  assert.deepEqual(new Set(p.touchedEntities), new Set([main.id, caller.id, helper.id]));
  assert.equal(p.touchedRelations.length, 2);
  // newDiagnosticEstimate is the honest floor: existing diagnostics on touched files
  assert.equal(p.newDiagnosticEstimate, 1);
  // the actual matches exactly -> zero error
  const err = cwm.recordEditDelta(main.id, { touchedEntities: p.touchedEntities, touchedRelations: p.touchedRelations });
  assert.equal(err!.jaccard, 1);
  assert.equal(err!.missed.length, 0);
  assert.equal(err!.spurious.length, 0);
  // settled: recording again returns null (one prediction per edit)
  assert.equal(cwm.recordEditDelta(main.id, { touchedEntities: [], touchedRelations: [] }), null);
});

test('cwm: surprise is measurable — an unpredicted relation lands in missed', () => {
  const cwm = new CodeWorldModel();
  // graph KNOWS caller->main but NOT secretAdmirer->main (incomplete graph)
  const secret: CodeEntity = { id: `${G}#secret`, kind: 'function', name: 'secret', uri: G };
  cwm.ingest({ entities: [main, helper, caller, secret], relations: rels });
  const p = cwm.predictEditDelta({ editKind: 'delete', target: main.id });
  // the edit ACTUALLY also broke secret (relation existed in reality, not in the model)
  const err = cwm.recordEditDelta(main.id, {
    touchedEntities: [...p.touchedEntities, secret.id],
    touchedRelations: [...p.touchedRelations, `${secret.id}->${main.id}:calls`],
  });
  assert.ok(err!.jaccard < 1, 'incomplete graph must yield measurable error');
  assert.ok(err!.missed.includes(secret.id), 'the unpredicted entity lands in missed');
  assert.ok(err!.missed.some((m) => m.endsWith(':calls')), 'the unpredicted relation lands in missed too');
  assert.equal(err!.spurious.length, 0);
  assert.ok(err!.precision < 1 && err!.recall === 1, 'recall perfect (all actual predicted earlier missed nothing? no — recall counts predicted found)');
});

test('cwm: state hash is content-sensitive for drift detection', () => {
  const a = new CodeWorldModel();
  a.ingest({ entities: [main, helper], relations: [rels[0]!] });
  const b = new CodeWorldModel();
  b.ingest({ relations: [rels[0]!], entities: [helper, main] }); // same content, different push order
  assert.equal(a.stateHash(), b.stateHash(), 'canonical: insertion order must not matter');
  b.ingest({ entities: [caller] });
  assert.notEqual(a.stateHash(), b.stateHash(), 'new entity changes the hash');
});
