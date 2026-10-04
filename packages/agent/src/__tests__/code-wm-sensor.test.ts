import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeWorldModel } from '@hmharness/cognitive';
import { syncCodeWorldModel, lspSymbolsToOntology, lspDiagnosticsToOntology } from '../code-wm-sensor.ts';
import type { DocumentSymbol, Diagnostic } from '@hmharness/lsp';

const URI = 'file:///src/app.ts';
// a realistic LSP documentSymbol payload: App class defines run(); top-level main
const symbols: DocumentSymbol[] = [
  {
    name: 'App',
    kind: 5, // class
    range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
    children: [
      { name: 'run', kind: 6, range: { start: { line: 2, character: 2 }, end: { line: 8, character: 2 } } }, // method
    ],
  },
  { name: 'main', kind: 12, range: { start: { line: 22, character: 0 }, end: { line: 30, character: 0 } } }, // function
];
const diagnostics: Diagnostic[] = [
  { range: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } }, severity: 1, message: "Cannot find name 'x'", source: 'clangd' },
];

test('sensor: LSP symbol tree maps to entities + PROVEN defines relations only', () => {
  const { entities, relations } = lspSymbolsToOntology(URI, symbols);
  assert.equal(entities.length, 3);
  const app = entities.find((e) => e.name === 'App')!;
  assert.equal(app.kind, 'class');
  const run = entities.find((e) => e.name === 'run')!;
  assert.equal(run.kind, 'method');
  assert.equal(run.range?.startLine, 3, 'LSP 0-based lines map to 1-based');
  // the ONLY relations emitted are defines edges the symbol tree proves
  assert.deepEqual(relations, [{ from: app.id, to: run.id, kind: 'defines' }]);
  // unknown kinds degrade honestly to 'field'
  const odd = lspSymbolsToOntology(URI, [{ name: 'weird', kind: 99, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } }]);
  assert.equal(odd.entities[0]!.kind, 'field');
});

test('sensor: diagnostics carry the source:lsp label into the model', () => {
  const diags = lspDiagnosticsToOntology(URI, diagnostics);
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.source, 'lsp');
  assert.equal(diags[0]!.severity, 1);
  assert.match(diags[0]!.message, /Cannot find name/);
});

test('sensor: full sync feeds the model; rename prediction works over LSP-derived entities end to end', () => {
  const cwm = new CodeWorldModel();
  const r1 = syncCodeWorldModel(cwm, { uri: URI, symbols, diagnostics });
  assert.equal(r1.entitiesIngested, 3);
  assert.equal(r1.relationsIngested, 1);
  assert.equal(r1.diagnosticsIngested, 1);
  assert.equal(cwm.entityCount, 3);
  assert.equal(cwm.diagnosticCount, 1);
  // end to end: predict renaming the class — its defined method rides along
  const appId = `${URI}#App`;
  const p = cwm.predictEditDelta({ editKind: 'rename', target: appId });
  assert.deepEqual(new Set(p.touchedEntities), new Set([appId, `${URI}#run`]));
  assert.equal(p.newDiagnosticEstimate, 1, 'the honest floor = existing diagnostics on the touched file');
  // second sync replaces diagnostics for the uri (fresh sensor state), symbols accumulate idempotently
  const r2 = syncCodeWorldModel(cwm, { uri: URI, symbols, diagnostics: [] });
  assert.equal(r2.diagnosticsIngested, 0);
  // an empty push must not wipe: absent list is "no data", not "cleared"
  assert.equal(cwm.diagnosticCount, 1);
  const before = cwm.stateHash();
  syncCodeWorldModel(cwm, { uri: URI, symbols, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, message: 'unused import', source: 'lsp' }] });
  assert.notEqual(cwm.stateHash(), before, 'a NEW diagnostic changes the model state');
});
