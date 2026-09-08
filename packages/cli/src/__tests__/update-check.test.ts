import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate, cmpSemver } from '../update-check.ts';
import { renderStats, type PkgStat } from '../npm-stats.ts';

test('cmpSemver: numeric per-component ordering (not lexicographic)', () => {
  assert.equal(cmpSemver('0.2.0', '0.2.0'), 0);
  assert.equal(cmpSemver('0.2.0', '0.10.0'), -1, '0.10 > 0.2 numerically; string compare would say otherwise');
  assert.equal(cmpSemver('1.0.0', '1.0.1'), -1);
  assert.equal(cmpSemver('2.0.0', '1.9.9'), 1);
  assert.equal(cmpSemver('0.2.0', '0.2.1-beta'), -1, 'prerelease suffix degrades to numeric 0 - fine for our hint');
});

test('checkForUpdate: outdated -> info; cache hit -> no network; failure -> null, no crash', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-upd-'));
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches++;
    return new Response(JSON.stringify({ latest: '9.9.9' }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    // 1. outdated: current 0.2.0 vs latest 9.9.9
    const r1 = await checkForUpdate({ home, current: '0.2.0', fetchImpl });
    assert.deepEqual(r1, { current: '0.2.0', latest: '9.9.9' });
    assert.equal(fetches, 1);
    // cache file written
    const cache = JSON.parse(await readFile(join(home, 'update-check.json'), 'utf8'));
    assert.equal(cache.latest, '9.9.9');

    // 2. fresh cache: same answer, ZERO extra fetches
    const r2 = await checkForUpdate({ home, current: '0.2.0', fetchImpl });
    assert.equal(r2?.latest, '9.9.9');
    assert.equal(fetches, 1, 'cached answer must not hit the network');

    // 3. up-to-date: current equals latest -> null
    const r3 = await checkForUpdate({ home, current: '9.9.9', fetchImpl });
    assert.equal(r3, null);

    // 4. stale cache (older than 24h) -> refetch
    await writeFile(join(home, 'update-check.json'), JSON.stringify({ time: Date.now() - 25 * 3600_000, latest: '0.0.1' }), 'utf8');
    const r4 = await checkForUpdate({ home, current: '0.2.0', fetchImpl });
    assert.equal(fetches, 2);
    assert.equal(r4?.latest, '9.9.9');

    // 5. network throws -> null, never rejects
    const bad = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const home2 = await mkdtemp(join(tmpdir(), 'hmh-upd-'));
    const r5 = await checkForUpdate({ home: home2, current: '0.2.0', fetchImpl: bad });
    assert.equal(r5, null);
    await rm(home2, { recursive: true, force: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('renderStats: aligned table, absent values as dash, honesty footnote', () => {
  const rows: PkgStat[] = [
    { name: '@hmharness/cli', day: 36, week: 208, month: 208 },
    { name: '@hmharness/web', day: null, week: 22, month: 22 },
  ];
  const out = renderStats(rows);
  assert.match(out, /package\s+day\s+week\s+month/);
  assert.match(out, /@hmharness\/cli\s+36\s+208\s+208/);
  assert.match(out, /@hmharness\/web\s+-\s+22\s+22/);
  assert.match(out, /downloads, not users/);
});
