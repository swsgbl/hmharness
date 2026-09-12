import test from 'node:test';
import assert from 'node:assert/strict';
import { TEAM_ROLES, TEAM_ROLE_NAMES, roleCharter } from '../roles.ts';

test('six canonical team roles exist, each with a duty contract', () => {
  assert.deepEqual(TEAM_ROLE_NAMES.sort(), ['coder', 'judge', 'planner', 'repairer', 'reviewer', 'tester']);
  for (const name of TEAM_ROLE_NAMES) {
    const r = TEAM_ROLES[name];
    assert.ok(r.charter.length > 60, name + ' has a real charter');
    assert.match(r.charter, /duty:/i);
  }
  // the judge role is evidence-first (M2 ladder, restated as a contract)
  assert.match(TEAM_ROLES.judge.charter, /evidence/i);
  assert.match(TEAM_ROLES.judge.charter, /VERDICT/);
});

test('roleCharter: canonical names resolve case-insensitively; free-form stays empty', () => {
  assert.match(roleCharter('Planner'), /PLANNER duty/);
  assert.equal(roleCharter('judge'), TEAM_ROLES.judge.charter);
  assert.equal(roleCharter('build-fixer'), '');
  assert.equal(roleCharter(''), '');
});
