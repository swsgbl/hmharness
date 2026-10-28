import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * i18n key symmetry (docx 第五阶段): zh and en label tables must expose the
 * SAME key set. A key present in one locale but missing in the other renders
 * as undefined text at runtime for half the users - this test catches it at
 * build time. Extracted from the PAGE template by evaluating the LABELS
 * object literal the same way the browser does.
 * P1-3 拆分:LABELS 随 core 域迁往 page/core.ts,两处候选依次探测。
 */
const here = dirname(fileURLToPath(import.meta.url));
let LABELS: Record<string, Record<string, unknown>> | null = null;
for (const p of [join(here, '../page.ts'), join(here, '../page/core.ts')]) {
  if (!existsSync(p)) continue;
  const m = /var LABELS = (\{[\s\S]*?\n  \});/.exec(readFileSync(p, 'utf8'));
  if (m) {
    // eslint-disable-next-line no-eval
    LABELS = eval(`(${m[1]})`) as Record<string, Record<string, unknown>>;
    break;
  }
}
assert.ok(LABELS, 'LABELS object literal found in page.ts / page/core.ts');

function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatKeys(v as Record<string, unknown>, key));
    else out.push(key);
  }
  return out.sort();
}

test('i18n: zh and en expose the identical label key set (no missing translations)', () => {
  assert.ok(LABELS.zh && LABELS.en, 'both locales exist');
  const zh = flatKeys(LABELS.zh as Record<string, unknown>);
  const en = flatKeys(LABELS.en as Record<string, unknown>);
  const zhSet = new Set(zh);
  const enSet = new Set(en);
  const missingInEn = zh.filter((k) => !enSet.has(k));
  const missingInZh = en.filter((k) => !zhSet.has(k));
  assert.deepEqual(missingInEn, [], `keys present in zh but missing in en: ${missingInEn.join(', ')}`);
  assert.deepEqual(missingInZh, [], `keys present in en but missing in zh: ${missingInZh.join(', ')}`);
});

test('i18n: no label is an empty string (a blank chip/button is a UI hole)', () => {
  for (const loc of ['zh', 'en']) {
    const walk = (obj: Record<string, unknown>, p: string) => {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === 'object') walk(v as Record<string, unknown>, `${p}.${k}`);
        else if (typeof v === 'string') assert.ok(v.trim().length > 0, `${loc}${p}.${k} is empty`);
      }
    };
    walk(LABELS[loc] as Record<string, unknown>, '');
  }
});
