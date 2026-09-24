import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSources, opsStatus, type RadarSourceInfo } from '../index.ts';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('describeSources prints labels+repos, never bare keys', () => {
  const list: RadarSourceInfo[] = [
    { key: 'oh-docs', label: 'OpenHarmony 文档', repo: 'openharmony/docs' },
    { key: 'oh-ace', label: 'ArkUI 框架', repo: 'openharmony/arkui_ace_engine' },
  ];
  const s = describeSources(list);
  assert.equal(s, 'OpenHarmony 文档 (openharmony/docs) · ArkUI 框架 (openharmony/arkui_ace_engine)');
  assert.equal(s.includes('oh-docs'), false, 'internal keys must not leak to humans');
});

test('opsStatus: scans counted, sources carry label+repo, no-scan home returns zero', async () => {
  const empty = await opsStatus(join(tmpdir(), 'hmh-ops-none-' + Date.now()));
  assert.equal(empty.scans, 0);
  assert.equal(empty.lastScan, undefined);
  assert.ok(empty.sources.length >= 4);
  for (const src of empty.sources) {
    assert.ok(src.label && src.repo, 'every source must be human-labelled');
  }
  // a home with two log lines reports 2 scans + last time
  const home = mkdtempSync(join(tmpdir(), 'hmh-ops-'));
  mkdirSync(join(home, 'ops'), { recursive: true });
  writeFileSync(join(home, 'ops', 'ops-log.jsonl'), '{"time":"2026-09-20T05:00:00.000Z"}\n{"time":"2026-09-20T13:49:22.000Z"}\n', 'utf8');
  const s = await opsStatus(home);
  assert.equal(s.scans, 2);
  assert.equal(s.lastScan, '2026-09-20T13:49:22.000Z');
});
