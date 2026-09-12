import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFeatures, recordRoutingOutcome, routeDecision, routingStats } from '../router.ts';

test('extractFeatures: complexity, language, domain heuristics', () => {
  const simple = extractFeatures('你们好');
  assert.equal(simple.domain, 'generic');
  assert.ok(simple.complexity < 0.2);
  assert.equal(simple.expectedContext, 'small');

  const harmony = extractFeatures('构建一个 HarmonyOS 应用，第1步写 ArkTS 页面，第2步配置 module.json5，然后 hvigorw 构建并修复所有报错');
  assert.equal(harmony.domain, 'harmony');
  assert.equal(harmony.language, 'arkts');
  assert.ok(harmony.complexity > 0.5);
  assert.equal(harmony.expectedContext, 'large');

  const cj = extractFeatures('用仓颉 cangjie 写一个 .cj 模块');
  assert.equal(cj.language, 'cangjie');
  assert.equal(cj.domain, 'harmony');
});

test('routeDecision: harmony route, heavy route, default passthrough', () => {
  const f = extractFeatures('构建一个 HarmonyOS 应用并排查 hvigor 报错，然后修复 module.json5');
  const sug = routeDecision(f, { actual: 'chat', harmonyRoute: 'glm-harmony' });
  assert.equal(sug.suggested, 'glm-harmony');
  assert.match(sug.reason, /harmony-domain/);
  // heavy context without harmony route
  const g = extractFeatures('然后 修复 ' + 'x'.repeat(700));
  const sug2 = routeDecision({ ...g, domain: 'generic' }, { actual: 'chat', heavyRoute: 'long-window' });
  assert.equal(sug2.suggested, 'long-window');
  // no alternative routes configured -> passthrough
  const sug3 = routeDecision(f, { actual: 'chat' });
  assert.equal(sug3.suggested, 'chat');
  assert.match(sug3.reason, /default route fits/);
  // suggestion equals actual when harmony route IS the actual
  const sug4 = routeDecision(f, { actual: 'glm-harmony', harmonyRoute: 'glm-harmony' });
  assert.equal(sug4.suggested, 'glm-harmony');
  assert.match(sug4.reason, /default route fits/);
});

test('routing outcome: record + stats with agreement/success split', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-rt-'));
  try {
    const mk = (actual: string, suggested: string, outcome?: string) => recordRoutingOutcome(home, {
      time: new Date().toISOString(),
      task: 't',
      features: extractFeatures('build harmony app'),
      actual,
      suggested,
      reason: 'x',
      ...(outcome ? { outcome } : {}),
    });
    // 10 agree (8 ok) + 10 disagree (2 ok) -> successAgree .8, successDisagree .2
    for (let i = 0; i < 10; i++) await mk('chat', 'chat', i < 8 ? 'ok' : 'error');
    for (let i = 0; i < 10; i++) await mk('chat', 'glm-harmony', i < 2 ? 'ok' : 'error');
    const s = await routingStats(home);
    assert.equal(s.total, 20);
    assert.equal(s.agreed, 10);
    assert.equal(s.disagreementRate, 0.5);
    assert.ok(Math.abs(s.successAgree! - 0.8) < 1e-9);
    assert.ok(Math.abs(s.successDisagree! - 0.2) < 1e-9);
    // below the n>=8 floor -> null (no premature conclusion)
    await mk('chat', 'long', 'ok');
    const s2 = await routingStats(home);
    assert.equal(s2.total, 21);
    assert.equal(s2.disagreementRate, 0.52, '11 disagreements of 21');
    // empty home -> zeroed stats, no throw
    const empty = await routingStats(await mkdtemp(join(tmpdir(), 'hmh-rt2-')));
    assert.equal(empty.total, 0);
    assert.equal(empty.successAgree, null);
  } finally { await rm(home, { recursive: true, force: true }); }
});
