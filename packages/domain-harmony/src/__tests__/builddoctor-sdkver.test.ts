import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseBuildFailure } from '../builddoctor.ts';

test('sdk-version signature: matches the ERROR CODE, survives hint-line churn (day-28 hardening)', () => {
  // real shape from day-28: hvigor code + a hint line mentioning build-profile
  const realLog = `ERROR: 00306042 Specification Limit Violation
> Check the project's build-profile.json5 for compatibleSdkVersion issues.`;
  const d1 = diagnoseBuildFailure(realLog);
  assert.ok(d1);
  assert.equal(d1!.kind, 'sdk-version');

  // the OLD behavior was incidental: strip the hint line and the generic
  // config regex stopped matching -> UNKNOWN. The code-based signature must
  // classify even without any hint text.
  const noHint = `ERROR: 00306042 Specification Limit Violation`;
  const d2 = diagnoseBuildFailure(noHint);
  assert.ok(d2, 'code alone must classify');
  assert.equal(d2!.kind, 'sdk-version');

  // and the fix text says the schema check does NOT cover version plausibility
  assert.match(d2!.fix, /does NOT validate version plausibility|does NOT validate/i);
});

test('generic config failures still classify as config (no regression)', () => {
  const d = diagnoseBuildFailure("parse error: Expected ',' but got '{' in module.json5");
  assert.ok(d);
  assert.equal(d!.kind, 'config');
});
