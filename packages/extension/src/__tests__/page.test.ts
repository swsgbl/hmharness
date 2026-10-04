import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPageSnapshot, summarizePage } from '../page.ts';
import type { RawPageData } from '../protocol.ts';

const raw = (over: Partial<RawPageData> = {}): RawPageData => ({
  url: 'https://example.com/a?b=1',
  title: '  Example   Domain  ',
  selection: '  用户  选区  ',
  headings: [
    { level: 1, text: 'Main' },
    { level: 2, text: '  Sub  One  ' },
    { level: 2, text: 'Sub One' }, // near-duplicate survives (honest: dedup is by link href, not heading text)
    { level: 9, text: 'clamped level' },
    { level: 2, text: '' }, // empty heading dropped
  ],
  links: [
    { text: 'Docs', href: 'https://example.com/docs' },
    { text: 'Docs again', href: 'https://example.com/docs' }, // deduped by href
    { text: 'JS', href: 'javascript:void(0)' }, // non-http dropped
    { text: 'Anchor', href: '#top' }, // non-http dropped
    { text: 'API', href: 'https://example.com/api' },
  ],
  inputs: [
    { tag: 'input', type: 'text', name: 'q', placeholder: 'Search…' },
    { tag: 'input', type: 'hidden', name: 'csrf', placeholder: '' }, // collector already drops hidden; summarizer tolerates
    { tag: 'textarea', type: 'textarea', name: 'note', placeholder: '' },
  ],
  text: 'hello   world\n\nnext   paragraph',
  ...over,
});

test('page: summarize normalizes headings/links/inputs and dedupes by href', () => {
  const s = summarizePage(raw());
  assert.equal(s.title, 'Example Domain'); // whitespace collapsed
  assert.equal(s.selection, '用户 选区');
  assert.deepEqual(s.outline, ['# Main', '  ## Sub One', '  ## Sub One', '          ###### clamped level']);
  assert.equal(s.links.length, 2); // javascript:/# dropped, dup href merged
  assert.ok(s.links[0]!.includes('Docs → https://example.com/docs'));
  assert.equal(s.inputs.length, 3); // summarizer passes through what the collector sent
  assert.equal(s.text, 'hello world next paragraph');
  assert.equal(s.truncated, false);
});

test('page: caps trip the truncated flag (text, links, outline, inputs)', () => {
  const links = Array.from({ length: 120 }, (_, i) => ({ text: `l${i}`, href: `https://example.com/${i}` }));
  const s = summarizePage(raw({ links, text: 'x'.repeat(20_000), inputs: Array.from({ length: 60 }, () => ({ tag: 'input', type: 'text', name: '', placeholder: '' })) }));
  assert.equal(s.links.length, 80);
  assert.equal(s.text.length, 8_000);
  assert.equal(s.truncated, true);
});

test('page: formatPageSnapshot renders the agent-facing sections', () => {
  const out = formatPageSnapshot(summarizePage(raw()));
  assert.ok(out.includes('Example Domain'));
  assert.ok(out.includes('https://example.com/a?b=1'));
  assert.ok(out.includes('[用户选区]') || out.includes('[用户 选区]'));
  assert.ok(out.includes('[大纲]'));
  assert.ok(out.includes('[表单]'));
  assert.ok(out.includes('[链接 2]'));
  assert.ok(out.includes('[正文]'));
  assert.ok(out.includes('hello world next paragraph'));
});
