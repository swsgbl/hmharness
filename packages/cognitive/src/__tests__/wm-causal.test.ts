import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mineCausalLinks, counterfactualWithout } from '../wm-causal.ts';
import type { Observation } from '../protocol.ts';
import type { Transition, WorldState } from '../world-model.ts';

let clock = 0;
function ws(variables: Record<string, unknown>): WorldState {
  clock += 1;
  return { environmentId: 'e', version: clock, entities: [], variables, beliefs: [], uncertainty: { byAction: {} } };
}
function obs(state: Record<string, unknown>): Observation {
  clock += 1;
  return { environmentId: 'e', timestamp: new Date(Date.now() + clock * 1000).toISOString(), state, availableActions: [] };
}
function tr(type: string, before: Record<string, unknown>, after: Record<string, unknown>): Transition {
  return {
    stateBefore: ws(before),
    action: { id: `a${clock}`, type, args: {}, reason: 't' },
    observation: obs(after),
    stateAfter: ws(after),
    outcome: 'success',
  };
}

test('wm-causal: mining finds the true cause with temporal precedence, rejects the bystander', () => {
  // deploy ALWAYS adds key `deployed` (true cause, 4 runs)
  // login NEVER touches it but runs alongside (bystander)
  const history: Transition[] = [
    tr('login', { user: 'x' }, { user: 'x', session: 1 }),
    tr('deploy', { app: 1 }, { app: 1, deployed: true }),
    tr('login', { user: 'y' }, { user: 'y', session: 2 }),
    tr('deploy', { app: 2 }, { app: 2, deployed: true }),
    tr('read', { f: 1 }, { f: 1, seen: true }),
    tr('deploy', { app: 3 }, { app: 3, deployed: true }),
    tr('deploy', { app: 4 }, { app: 4, deployed: true }),
  ];
  const links = mineCausalLinks(history, { minSupport: 2, minLift: 0.3 });
  const deployLink = links.find((l) => l.actionType === 'deploy' && l.stateKey === 'deployed');
  assert.ok(deployLink, 'deploy→deployed must be mined');
  assert.ok(deployLink.lift >= 0.5, `lift should be strong (deploy always changes it), got ${deployLink.lift}`);
  assert.equal(deployLink.support, 4);
  assert.equal(deployLink.lag, 0);
  assert.equal(deployLink.evidence, 'observational', 'every link is stamped observational');
  // the bystander never touches `deployed` -> no link at all
  assert.ok(!links.some((l) => l.actionType === 'login' && l.stateKey === 'deployed'), 'login must NOT be linked to deployed');
});

test('wm-causal: lag-1 detection — the effect lands in the NEXT transition (confound broken)', () => {
  // seed -> the NEXT step grows; other WITHOUT a preceding seed does NOT grow
  // (a history where other always grew would perfectly confound the two)
  const history: Transition[] = [
    tr('seed', { n: 0 }, { n: 0 }),          // lag0: no change
    tr('other', { n: 0 }, { n: 10 }),        // growth lands = lag 1 from seed
    tr('other', { n: 10 }, { n: 10 }),       // other ALONE: no growth
    tr('seed', { n: 10 }, { n: 10 }),        // lag0: no change
    tr('other', { n: 10 }, { n: 25 }),      // growth again = lag 1 from seed
    tr('other', { n: 25 }, { n: 25 }),      // other ALONE: no growth
  ];
  const links = mineCausalLinks(history, { minSupport: 2, minLift: 0.3 });
  const lagged = links.find((l) => l.actionType === 'seed' && l.stateKey === 'n');
  assert.ok(lagged, 'seed→n must be mined through the lag-1 window');
  assert.equal(lagged.lag, 1, 'the effect is one step after the action');
  assert.equal(lagged.support, 2);
  // HONEST observational reading: the proximate correlate (other, lag 0) may
  // also appear — growth happens during other's steps, that correlation is
  // real. What observational mining CAN do is rank: seed's lag-1 link must
  // outrank other's lag-0 link (lift 1.0 vs 0.5 — seed explains the
  // conditional structure: other-alone never grows).
  const otherLink = links.find((l) => l.actionType === 'other' && l.stateKey === 'n');
  if (otherLink) {
    assert.ok(lagged.lift > otherLink.lift, `seed must outrank the proximate correlate (seed ${lagged.lift} vs other ${otherLink.lift})`);
    assert.ok(otherLink.lift < 1, 'other-only growth never happens, so its lift cannot be perfect');
  }
});

test('wm-causal: counterfactual replay — beliefs that would NOT exist', () => {
  const history: Transition[] = [
    tr('build', { f: 0 }, { f: 1, built: true }),
    tr('build', { f: 1 }, { f: 2, built: true }),
    tr('test', { f: 2 }, { f: 2, tested: true }),
  ];
  const report = counterfactualWithout(history, 'build');
  assert.equal(report.nature, 'model-based-extrapolation', 'honest epistemic label on every report');
  assert.equal(report.excludedTransitions, 2);
  // the real world learned act:build; the counterfactual never saw it
  assert.ok(report.lostBeliefs.some((b) => b.actionType === 'build'), 'removing build must lose the act:build belief');
  assert.ok(!report.lostBeliefs.some((b) => b.actionType === 'test'), 'test belief survives (its transitions remain)');
  assert.equal(report.counterfactualBeliefs, report.realBeliefs - 1);
});
