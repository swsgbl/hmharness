/**
 * setLabels must survive a page whose parts have gone (2026-11-26, found in the
 * end-to-end pass).
 *
 * The welcome card's caption ids disappear with the first "new session" and the detail
 * pane's #dempty disappears the first time a tool row is clicked. setLabels used to write
 * them unguarded, so it threw inside renderState - and from then on the tab dropped EVERY
 * later state update (queue, busy, model, theme, workspace switch, session list). These
 * tests run the REAL function, cut out of the page template, against documents that are
 * missing those elements.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE } from '../page/core.ts';

const lf = (s: string): string => s.replace(/\r\n/g, '\n');
const src = lf(CORE);
const labelsSrc = /var LABELS = (\{[\s\S]*?\n  \});/.exec(src)?.[1];
const from = src.indexOf('  function named(id, text)');
const to = src.indexOf('\n  /* ---- view switching', from);
assert.ok(labelsSrc && from >= 0 && to > from, 'LABELS and the label functions are found in the page kernel');

type El = { textContent: string; placeholder: string; title: string; attrs: Record<string, string>; options: unknown[]; setAttribute(k: string, v: string): void };
function fakeDoc(present: Set<string>) {
  const els = new Map<string, El>();
  const mk = (): El => {
    const e: El = {
      textContent: '', placeholder: '', title: '', attrs: {}, options: [{}, {}, {}],
      setAttribute(k: string, v: string) { e.attrs[k] = v; },
    };
    return e;
  };
  return {
    title: '', documentElement: { lang: '' },
    body: { classList: { contains: () => false } },
    getElementById(id: string): El | null { return present.has(id) ? (els.get(id) ?? (els.set(id, mk()), els.get(id)!)) : null; },
    querySelector(sel: string): El | null { return sel === '#rtabs' || sel === '#side nav' ? mk() : null; },
    querySelectorAll(): El[] { return []; },
  };
}
type Doc = ReturnType<typeof fakeDoc>;

/** setLabels as the page has it, bound to one fake document. */
function setLabelsFor(doc: Doc): (loc: string) => void {
  const make = new Function('document', 'updateSendBtn',
    'var LABELS = ' + labelsSrc + ';\nvar L = null; var curView = "chat";\n' + src.slice(from, to) + '\nreturn setLabels;');
  return make(doc as unknown as Document, () => {}) as (loc: string) => void;
}

/** Every id the static markup carries (the complete page). */
const ALL = new Set([...src.slice(from, to).matchAll(/(?:txt|ph|attr|named|labelled)\('([\w-]+)'/g)].map((m) => m[1]));

test('the complete page: every label is written', () => {
  const doc = fakeDoc(ALL);
  setLabelsFor(doc)('en');
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(doc.getElementById('locale-chip')!.textContent, 'en');
  assert.equal(doc.getElementById('board-title')!.textContent, 'Task board');
  assert.equal(doc.getElementById('set-title')!.textContent, 'Settings');
});

test('after the first "new session": the welcome captions are gone and nothing may throw', () => {
  const doc = fakeDoc(new Set([...ALL].filter((id) => id !== 'empty-title' && id !== 'empty-sub')));
  const setLabels = setLabelsFor(doc);
  assert.doesNotThrow(() => setLabels('en'), 'the two caption writes are skipped, not fatal');
  // everything AFTER the old throw point is still applied
  assert.equal(doc.getElementById('board-title')!.textContent, 'Task board', 'later labels still update');
  assert.ok(doc.getElementById('ws-add')!.textContent.length > 0, 'workspace labels still update');
  assert.equal(doc.getElementById('rtab-detail')!.textContent, 'Detail', 'the last lines of the function still run');
});

test('after a tool row was clicked: #dempty is gone and nothing may throw', () => {
  const doc = fakeDoc(new Set([...ALL].filter((id) => id !== 'dempty')));
  assert.doesNotThrow(() => setLabelsFor(doc)('en'));
  assert.equal(doc.getElementById('rtab-files')!.textContent, 'Files');
});

test('a bare document (almost everything missing) still sets the document language and title', () => {
  const doc = fakeDoc(new Set());
  assert.doesNotThrow(() => setLabelsFor(doc)('en'));
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(doc.title, 'hmh web');
});
