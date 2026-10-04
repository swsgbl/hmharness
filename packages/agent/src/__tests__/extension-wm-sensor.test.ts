import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeWorldModel } from '@hmharness/cognitive';
import type { RawPageData } from '@hmharness/extension';
import { pageReadToRuntimeFacts, syncExtensionRuntime } from '../extension-wm-sensor.ts';

const raw = (over: Partial<RawPageData> = {}): RawPageData => ({
  url: 'https://hmharness.dev/docs',
  title: 'Docs',
  selection: '',
  headings: [{ level: 1, text: 'Docs' }],
  links: [{ text: 'Home', href: 'https://hmharness.dev/' }],
  inputs: [],
  text: 'the documentation body',
  ...over,
});

test('sensor: page read maps to exactly ONE runtime fact; selection adds exactly one more', () => {
  const noSel = pageReadToRuntimeFacts(raw(), '2026-10-04T00:00:00Z');
  assert.equal(noSel.length, 1);
  assert.deepEqual(noSel[0], { kind: 'ext.page.read', detail: 'Docs — https://hmharness.dev/docs', at: '2026-10-04T00:00:00Z' });
  const withSel = pageReadToRuntimeFacts(raw({ selection: '用户选中了这段' }), '2026-10-04T00:00:01Z');
  assert.equal(withSel.length, 2);
  assert.equal(withSel[1]!.kind, 'ext.page.selection');
  assert.equal(withSel[1]!.detail, '用户选中了这段');
  // whitespace collapse + caps on noisy input (a 400-char selection is context, not fact)
  const noisy = pageReadToRuntimeFacts(raw({ title: 'A'.repeat(400), selection: '  x  '.repeat(100) }));
  assert.ok(noisy[0]!.detail.length <= 300 + 200);
  assert.ok(noisy[1]!.detail.length <= 200);
  // no title: the URL alone still identifies the observation
  const bare = pageReadToRuntimeFacts(raw({ title: '' }));
  assert.equal(bare[0]!.detail, 'https://hmharness.dev/docs');
});

test('sensor: sync ingests into the Code World Model; stateHash UNCHANGED (runtime is evidence, not code state)', () => {
  const cwm = new CodeWorldModel();
  const before = cwm.stateHash();
  const r1 = syncExtensionRuntime(cwm, raw());
  assert.equal(r1.factsIngested, 1);
  const r2 = syncExtensionRuntime(cwm, raw({ url: 'https://other.dev', selection: 'look here' }));
  assert.equal(r2.factsIngested, 2);
  // read back through the runtime accessor (write-only stores can't be audited)
  const facts = cwm.runtime;
  assert.equal(facts.length, 3);
  assert.deepEqual(facts.map((f) => f.kind), ['ext.page.read', 'ext.page.read', 'ext.page.selection']);
  assert.ok(facts[1]!.detail.includes('other.dev'));
  // the documented invariant: browsing evidence must not move the code-state hash
  assert.equal(cwm.stateHash(), before);
});
