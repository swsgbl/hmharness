import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCases, matchExpect, seedCases } from '../bench.ts';

test('matchExpect requires every && part, case-insensitive', () => {
  assert.equal(matchExpect('hdc hvigorw ohpm all OK', ['hdc', 'hvigorw', 'ohpm']), true);
  assert.equal(matchExpect('hdc ok but no build tool', ['hdc', 'hvigorw']), false);
  assert.equal(matchExpect('HDC uppercase', ['hdc']), true);
  assert.equal(matchExpect('anything', []), true);
});

test('seedCases is idempotent and cases parse with holdout/tools flags', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-bench-'));
  try {
    const first = await seedCases(home);
    assert.ok(first.length >= 2, 'seeds on fresh home');
    const again = await seedCases(home);
    assert.equal(again.length, 0, 'second seed writes nothing');
    const cases = await listCases(home);
    const tc = cases.find((c) => c.name.includes('toolchain-report'));
    assert.ok(tc?.tools, 'toolchain case runs through the loop');
    assert.ok(!tc?.holdout);
    const ho = cases.find((c) => c.holdout);
    assert.ok(ho, 'a holdout case exists');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
