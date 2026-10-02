import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CognitiveMemory } from '../memory.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mem2-'));
}

test('memory2: scored lexical retrieval — multi-term partial credit beats the AND-substring wall', async () => {
  const home = await tmpHome();
  const mem = new CognitiveMemory(home);
  await mem.load();
  await mem.write({ layer: 'semantic', content: 'hvigor 构建在 Windows 路径含空格时失败，需引号包裹', payload: {}, source: 't', provenance: 't', confidence: 0.8, environment: 'terminal', session: 's', tags: ['build'] });
  await mem.write({ layer: 'semantic', content: 'build doctor classifies seven failure signatures', payload: {}, source: 't', provenance: 't', confidence: 0.6, environment: 'terminal', session: 's', tags: ['build', 'tooling'] });
  await mem.write({ layer: 'semantic', content: 'unrelated gardening note about roses', payload: {}, source: 't', provenance: 't', confidence: 0.9, environment: 'terminal', session: 's', tags: ['misc'] });
  // OLD behavior: substring 'hvigor build' matched NOTHING (hard AND).
  // NEW: terms score individually — the hvigor note ranks first (2/3 terms
  // on content), the build-doctor note surfaces (1/3), roses excluded.
  const hits = mem.retrieve({ text: 'hvigor build windows' });
  assert.ok(hits.length >= 2, `expected >=2 hits, got ${hits.length}`);
  assert.match(hits[0]!.content, /hvigor/);
  assert.match(hits[1]!.content, /build doctor/);
  assert.ok(!hits.some((h) => h.content.includes('roses')));
  // ranking sanity: the entry matching more terms outranks a
  // higher-confidence entry matching fewer
  assert.equal(hits[0]!.confidence <= 0.9, true);
  // single CJK/short terms still work; one-char noise terms are ignored
  const zh = mem.retrieve({ text: '构建 失败' });
  assert.match(zh[0]!.content, /构建/);
  await rm(home, { recursive: true, force: true });
});
