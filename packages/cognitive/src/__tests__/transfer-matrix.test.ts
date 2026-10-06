import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSFER_ENVIRONMENTS,
  LITERAL_ENVIRONMENT,
  ABSTRACT_ACTION_MAP,
  environmentAbstractActions,
  transferMatrix,
  abstractOf,
} from '../abstract-actions.ts';

test('matrix: every attributed literal has an abstract edge (tables stay in lockstep)', () => {
  for (const literal of Object.keys(LITERAL_ENVIRONMENT)) {
    assert.ok(ABSTRACT_ACTION_MAP[literal], `literal '${literal}' attributed to an environment but has NO abstract edge`);
  }
  for (const literal of Object.keys(ABSTRACT_ACTION_MAP)) {
    // edges without env attribution are allowed (agent-generic tools) - but
    // every env in the matrix must be non-empty
  }
  for (const env of TRANSFER_ENVIRONMENTS) {
    assert.ok(environmentAbstractActions(env).length > 0, `${env} has no verbs - an empty row would fake 'no-overlap' everywhere`);
  }
});

test('matrix: derived verb sets are the attributed unions, hand-checked', () => {
  assert.deepEqual(environmentAbstractActions('terminal'), ['edit', 'observe', 'query', 'read', 'remove', 'run', 'write']);
  assert.deepEqual(environmentAbstractActions('harmonyos'), ['create', 'install', 'launch', 'run', 'verify']);
  assert.deepEqual(environmentAbstractActions('arc3'), ['interact']);
  assert.deepEqual(environmentAbstractActions('browser'), ['interact', 'navigate', 'observe', 'read']);
  assert.ok(environmentAbstractActions('desktop').includes('interact'));
  // the new verbs landed where they should
  assert.equal(abstractOf('harmony_build'), 'verify');
  assert.equal(abstractOf('harmony_project_create'), 'create');
  assert.equal(abstractOf('extension_page_read'), 'read');
});

test('matrix: 5x5 with honest statuses - evidence only from controlled experiments', () => {
  const m = transferMatrix([
    { sourceEnv: 'terminal', targetEnv: 'harmonyos', score: 0.4166, verdict: 'positive', runsPerArm: 12 },
  ]);
  assert.equal(m.length, 5);
  for (const row of m) assert.equal(row.length, 5);
  const at = (s: string, t: string) => m[TRANSFER_ENVIRONMENTS.indexOf(s as never)][TRANSFER_ENVIRONMENTS.indexOf(t as never)];
  assert.equal(at('terminal', 'terminal').status, 'same-env');
  const th = at('terminal', 'harmonyos');
  assert.equal(th.status, 'evidence');
  assert.equal(th.evidence?.score, 0.4166);
  assert.deepEqual(th.overlap, ['run']);
  const ht = at('harmonyos', 'terminal');
  assert.equal(ht.status, 'overlap-no-evidence', 'the REVERSE direction has no experiment - overlap alone is never evidence');
  const ta = at('terminal', 'arc3');
  assert.equal(ta.status, 'no-overlap', 'terminal{edit,observe,query,read,remove,run,write} vs arc3{interact} share nothing');
  const ba = at('browser', 'arc3');
  assert.equal(ba.status, 'overlap-no-evidence');
  assert.deepEqual(ba.overlap, ['interact']);
  assert.ok(ba.jaccard > 0 && ba.jaccard < 1);
});

test('matrix: jaccard math - |A∩B| / |A∪B| hand-checked', () => {
  const m = transferMatrix([]);
  const ba = m[TRANSFER_ENVIRONMENTS.indexOf('browser')][TRANSFER_ENVIRONMENTS.indexOf('arc3')];
  // browser {interact,navigate,observe,read} vs arc3 {interact}: 1/4
  assert.equal(ba.jaccard, 0.25);
});
