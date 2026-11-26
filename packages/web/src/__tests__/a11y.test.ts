/**
 * Accessibility and input invariants of the page (2026-11-25, modern-web-guidance).
 * These pin the behaviours a later edit could silently undo: focus isolation behind the
 * modal overlays, the landmark/label structure, the IME-safe Enter/Escape handling and the
 * CSS rules that keep focus visible, motion optional and states readable in forced colors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE } from '../page.ts';
import { HEAD } from '../page/head.ts';
import { BODY } from '../page/body.ts';
import { CORE } from '../page/core.ts';
import { uiLiteSource } from '../uilite.ts';

const here = dirname(fileURLToPath(import.meta.url));
/** The page sources are checked out with CRLF on Windows and LF elsewhere; the template
 *  literals carry whatever the file has, so every assertion runs on LF text. */
const lf = (s: string): string => s.replace(/\r\n/g, '\n');
const part = (name: string): string => lf(readFileSync(join(here, '..', 'page', name), 'utf8'));
const page = lf(PAGE);
const head = lf(HEAD);
const body = lf(BODY);
const core = lf(CORE);
const JS = ['core.ts', 'workspaces.ts', 'views.ts', 'settings.ts', 'sessions.ts', 'dock.ts', 'sse.ts', 'chrome.ts', 'composer.ts', 'shell.ts']
  .map(part).join('\n');

/** Top-level page functions, by name: `  function name(args) {` … `\n  }`. */
function pageFunctions(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^  function (\w+)\([^)]*\) \{\n([\s\S]*?)\n  \}$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.set(m[1], m[2]);
  return out;
}

// ---------- modal overlays: the page behind them is inert ----------

class FakeObserver {
  static last: FakeObserver | null = null;
  targets: any[] = [];
  cb: () => void;
  constructor(cb: () => void) { this.cb = cb; FakeObserver.last = this; }
  observe(t: any) { this.targets.push(t); }
  disconnect() { this.targets = []; }
  fire() { this.cb(); }
}

interface FakeEl {
  id: string;
  attrs: Record<string, string>;
  classList: { contains(c: string): boolean; add(c: string): void; delete(c: string): void };
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
}

function fakePage(overlayIds: string[]): { doc: unknown; regions: FakeEl[]; overlays: FakeEl[]; body: FakeEl } {
  const mk = (id: string): FakeEl => {
    const on = new Set<string>();
    const el: FakeEl = {
      id, attrs: {},
      classList: { contains: (c: string) => on.has(c), add: (c: string) => { on.add(c); }, delete: (c: string) => { on.delete(c); } },
      setAttribute(k: string, v: string) { el.attrs[k] = v; },
      removeAttribute(k: string) { delete el.attrs[k]; },
    };
    return el;
  };
  // element ids carry no '#': the drawer rule compares r.id with 'side'
  const regions = ['side', 'main', 'rightbar'].map(mk);
  const overlays = overlayIds.map(mk);
  const body = mk('body');
  const doc = { body, querySelectorAll: (sel: string) => (sel === '#side, #main, #rightbar' ? regions : overlays) };
  return { doc, regions, overlays, body };
}

/** The function as the page receives it: cut from the serialized bundle, not the module —
 *  together with the bundle's own prelude. Under tsx (the way CI runs the suite) the
 *  serialized body contains `__name(...)` calls; the page gets the helper from the prelude,
 *  so the test must too (under --experimental-strip-types there is none). */
function serialized(name: string): (...args: any[]) => any {
  const src = lf(uiLiteSource());
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `${name} is in the serialized page bundle`);
  const prelude = src.slice(0, src.indexOf('\nfunction '));
  assert.ok(prelude.includes('__name'), 'the bundle prelude defines the __name helper');
  const fnSrc = src.slice(start, endOf(src, start));
  assert.ok(fnSrc.length > 200, `${name}: the whole function was cut from the bundle`);
  assert.ok(!/=>|\bconst\b|\blet\b/.test(fnSrc), 'the function is plain script in the page');
  return new Function(prelude + '\n' + fnSrc + '\nreturn ' + name + ';')() as (...args: any[]) => any;
}
/** End of a top-level function in the bundle: the column-0 closing brace, or the end of
 *  the text when it is the last function (the bundle has no trailing newline). */
function endOf(src: string, start: number): number {
  const at = src.indexOf('\n}\n', start);
  return at < 0 ? src.length : at + 3;
}
/** Body of a `@media` block as it is written in the stylesheet (2-space indented rules). */
function mediaBlock(css: string, query: string): string {
  const m = new RegExp('@media \\(' + query + '\\) \\{([\\s\\S]*?)\\n  \\}').exec(css);
  assert.ok(m, `the stylesheet has a "@media (${query})" block`);
  return m[1];
}

test('modal overlays: an open overlay makes every region behind it inert; closing restores them', () => {
  const prev = globalThis.MutationObserver;
  delete (globalThis as any).MutationObserver;
  try {
    const wire = serialized('wireModalInert');
    const { doc, regions, overlays } = fakePage(['#wspick', '#cmdpal', '#pairmod']);
    const h = wire(doc);
    assert.deepEqual(regions.map((r) => r.attrs.inert), [undefined, undefined, undefined], 'nothing is open at first');
    overlays[1].classList.add('on');
    h.sync();
    assert.deepEqual(regions.map((r) => r.attrs.inert), ['', '', ''], 'inert is set as a bare attribute');
    overlays[0].classList.add('on');
    overlays[1].classList.delete('on');
    h.sync();
    assert.deepEqual(regions.map((r) => r.attrs.inert), ['', '', ''], 'the other overlay is still open');
    overlays[0].classList.delete('on');
    h.sync();
    assert.deepEqual(regions.map((r) => r.attrs.inert), [undefined, undefined, undefined], 'everything closed: the page is usable again');
  } finally {
    if (prev) (globalThis as any).MutationObserver = prev;
  }
});

test('modal overlays: the class observer re-derives the inert state on its own (no close path can leave the page stuck)', () => {
  const prev = globalThis.MutationObserver;
  (globalThis as any).MutationObserver = FakeObserver;
  try {
    const { doc, regions, overlays, body } = fakePage(['#wspick', '#cmdpal', '#pairmod']);
    const h = serialized('wireModalInert')(doc);
    const mo = FakeObserver.last!;
    assert.deepEqual(mo.targets.slice(0, 3), overlays, 'every overlay is observed');
    assert.equal(mo.targets[3], body, 'and the body (its class carries the phone drawer)');
    overlays[2].classList.add('on');
    mo.fire();
    assert.ok(regions.every((r) => r.attrs.inert === ''), 'opening anywhere is picked up');
    overlays[2].classList.delete('on');
    mo.fire();
    assert.ok(regions.every((r) => r.attrs.inert === undefined), 'closing anywhere is picked up');
    h.disconnect();
    assert.deepEqual(mo.targets, [], 'disconnect detaches the observer');
  } finally {
    if (prev) (globalThis as any).MutationObserver = prev;
    else delete (globalThis as any).MutationObserver;
  }
});

test('phone drawer: while it is open only the page BEHIND it is inert - the sidebar stays live', () => {
  const prev = globalThis.MutationObserver;
  delete (globalThis as any).MutationObserver;
  try {
    const { doc, regions, body } = fakePage(['#wspick', '#cmdpal', '#pairmod']);
    const h = serialized('wireModalInert')(doc);
    const inertNow = () => regions.filter((r) => r.attrs.inert === '').map((r) => r.id);
    assert.deepEqual(inertNow(), [], 'closed: nothing is inert');
    body.classList.add('mobside');
    h.sync();
    assert.deepEqual(inertNow(), ['main', 'rightbar'], 'open: the page behind the backdrop, never the drawer itself');
    body.classList.delete('mobside');
    h.sync();
    assert.deepEqual(inertNow(), [], 'closed again: the page is live');
  } finally {
    if (prev) (globalThis as any).MutationObserver = prev;
  }
});

test('phone drawer behaves like a dialog: focus moves in and out, backdrop and Escape close it, widening folds it', () => {
  const shell = part('shell.ts');
  assert.ok(/function setDrawer\(open\) \{[^}]*classList\.toggle\('mobside', open\);\s*syncModals\(\);/.test(shell), 'syncModals() runs right after the class changes, before any focus move');
  assert.ok(shell.includes("if (open) {\n      document.getElementById('newbtn').focus();") || /if \(open\) \{\s*document\.getElementById\('newbtn'\)\.focus\(\);/.test(shell), 'focus moves into the drawer when it opens');
  assert.ok(shell.includes("document.getElementById('sideburger').focus();"), 'and back to the burger when it closes');
  assert.ok(/document\.addEventListener\('click', function \(ev\) \{[^}]*mobside[^}]*t\.closest\('#side'\) \|\| t\.closest\('#sideburger'\)/.test(shell), 'a tap outside closes it; the burger\'s own click is exempt');
  assert.ok(shell.includes("else if (document.body.classList.contains('mobside')) setDrawer(false);"), 'Escape closes it');
  assert.ok(shell.includes("matchMedia('(max-width: 640px)')") && shell.includes('if (!q.matches) setDrawer(false);'), 'widening past the phone layout folds it away');
});

test('phone drawer: a click that opens it does not close it again (the burger click bubbles to the document)', () => {
  // the handler order is target first (opens), then document (would close): the exempt
  // clause is what keeps the drawer open - pin its exact shape
  const shell = part('shell.ts');
  const handler = shell.slice(shell.indexOf("document.addEventListener('click', function (ev) {\n    if (!document.body.classList.contains('mobside')) return;"));
  assert.ok(handler.indexOf("t.closest('#sideburger')") < handler.indexOf('setDrawer(false);'), 'the burger is exempt BEFORE the close call');
});

test('lists and notices: file-tree rows are buttons, the queued notice renders once, the turn card names the task that ran', () => {
  const dock = part('dock.ts'), sse = part('sse.ts'), composer = part('composer.ts');
  assert.ok(/var row = document\.createElement\('button'\);\s*row\.type = 'button';\s*row\.className = 'frow ' \+ kind;/.test(dock), 'file-tree rows are native buttons');
  assert.ok(dock.includes("row.setAttribute('aria-expanded',") && dock.includes("ic.setAttribute('aria-hidden', 'true');"), 'folders announce folding, the icon is decorative');
  assert.equal((sse.match(/function noteQueued\(/g) || []).length, 1, 'one queued-notice function');
  assert.ok(sse.includes('noteQueued(String(d.task || \'\'), d.position);') && composer.includes('noteQueued(text, res.d.position);'), 'both the SSE event and the POST response go through it');
  assert.equal(((sse + composer).match(/el\('div', 'queued'/g) || []).length, 1, 'exactly one place renders the notice');
  assert.ok(sse.includes('if (v.runningTask) v.lastTask = v.runningTask;') && sse.includes('v.runningTask = d.task;'), 'the turn card and regenerate button name the task that ran, not the queued one');
  const core = part('core.ts');
  assert.ok(/if \(w\.id === curWs\.id\) \{\s*x\.disabled = true;\s*x\.title = L \? L\.wsActive : 'active workspace';/.test(part('workspaces.ts')), 'the active workspace\'s remove button is disabled and says why');
  assert.ok(core.includes("wsActive:'当前工作区,不能移除(先切换到别的工作区)'") && core.includes("wsActive:'active workspace - switch away before removing'"), 'in both languages');
});

test('modal overlays: the wiring targets exactly the three overlays and the three regions of the page', () => {
  const src = lf(uiLiteSource());
  const wireSrc = src.slice(src.indexOf('function wireModalInert('));
  // quote-agnostic: tsx re-prints the literals with double quotes, strip-types keeps them
  const q = (sel: string): RegExp => new RegExp('querySelectorAll\\(["\u0027]' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\u0027]\\)');
  assert.ok(q('#side, #main, #rightbar').test(wireSrc), 'regions selector');
  assert.ok(q('#wspick, #cmdpal, #pairmod').test(wireSrc), 'overlays selector');
  for (const id of ['side', 'main', 'rightbar', 'wspick', 'cmdpal', 'pairmod']) {
    assert.ok(body.includes(`id="${id}"`), `#${id} exists in the static markup`);
  }
  // an overlay must sit OUTSIDE the regions it puts inert, or it would inert itself
  const mainStart = body.indexOf('<main id="main"');
  const mainEnd = body.indexOf('</main>');
  const sideEnd = body.indexOf('</aside>', body.indexOf('<aside id="side"'));
  const dockStart = body.indexOf('<aside id="rightbar"');
  const dockEnd = body.indexOf('</aside>', dockStart);
  for (const id of ['wspick', 'cmdpal', 'pairmod']) {
    const at = body.indexOf(`id="${id}"`);
    assert.ok(at > sideEnd && at > mainEnd && (at < dockStart || at > dockEnd), `#${id} is not inside a region`);
  }
  assert.ok(mainStart > 0 && mainEnd > mainStart, 'the main landmark is well formed');
  assert.ok(core.includes('var syncModals = wireModalInert(document).sync;'), 'the page keeps sync() for its close paths');
});

test('modal overlays: every close path re-enables the page BEFORE moving focus back into it', () => {
  const fn = pageFunctions(JS);
  const closers = ['closeCmdPal', 'closePick', 'closePairModal'];
  for (const name of closers) {
    const fnBody = fn.get(name);
    assert.ok(fnBody, `${name} exists`);
    const syncAt = fnBody.indexOf('syncModals()');
    assert.ok(syncAt >= 0, `${name} calls syncModals()`);
    const focusAt = fnBody.indexOf('.focus()');
    if (focusAt >= 0) assert.ok(syncAt < focusAt, `${name}: syncModals() runs before .focus()`);
  }
  // and nobody closes an overlay behind the closers' back
  const direct = JS.match(/(?:getElementById\('(?:wspick|cmdpal|pairmod)'\)|pel\('pairmod'\))\.classList\.remove\('on'\)/g) || [];
  assert.equal(direct.length, closers.length, 'each overlay is closed in exactly one place');
});

// ---------- structure ----------

test('structure: one main landmark with one h1, the two columns are complementary, overlays are dialogs', () => {
  assert.equal((body.match(/<main\b/g) || []).length, 1, 'exactly one <main>');
  assert.equal((body.match(/<h1\b/g) || []).length, 1, 'exactly one <h1>');
  assert.ok(/<h1 class="visually-hidden" id="app-title">/.test(body), 'the page heading is screen-reader text');
  assert.equal((body.match(/<aside\b/g) || []).length, 2, 'sidebar + right column are <aside>');
  for (const id of ['wspick', 'cmdpal', 'pairmod']) {
    const tag = body.slice(body.indexOf(`<div id="${id}"`)).match(/^<div[^>]*>/)![0];
    assert.ok(tag.includes('role="dialog"') && tag.includes('aria-modal="true"'), `#${id} is a modal dialog`);
    assert.ok(/aria-(label|labelledby)="[^"]+"/.test(tag), `#${id} has an accessible name`);
  }
  const ids = Array.from(body.matchAll(/ id="([^"]+)"/g)).map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, `ids are unique (duplicate: ${ids.find((id, i) => ids.indexOf(id) !== i)})`);
  const jsCreated = new Set(['modelpick']);
  for (const m of body.matchAll(/aria-(?:labelledby|controls)="([^"]+)"/g)) {
    for (const ref of m[1].split(/\s+/)) {
      assert.ok(ids.includes(ref) || jsCreated.has(ref), `aria reference #${ref} resolves`);
    }
  }
});

test('structure: every icon-only button in the static markup has an accessible name', () => {
  const buttons = Array.from(body.matchAll(/<button\b([^>]*)>([^<]*(?:<[^/][^>]*>[^<]*<\/\w+>\s*)*)<\/button>/g));
  assert.ok(buttons.length > 30, 'the markup was parsed');
  // these two carry no text in the markup: the script fills them in (model name / goal)
  const filledByScript = new Set(['model', 'goal-chip']);
  const unnamed: string[] = [];
  for (const m of buttons) {
    const id = / id="([^"]+)"/.exec(m[1])?.[1] ?? '(no id)';
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    // letters, digits or CJK make a visible name; emoji and symbols alone do not
    const hasName = /[\p{L}\p{N}]/u.test(text) || /aria-label="[^"]+"/.test(m[1]) || (filledByScript.has(id) && text === '');
    if (!hasName) unnamed.push(id);
  }
  assert.deepEqual(unnamed, [], 'icon-only buttons without aria-label');
  // …and the script really does fill the two deferred ones
  assert.ok(/getElementById\('model'\)\.textContent = s\.model;/.test(core), 'the model chip gets the model name');
  assert.ok(core.includes('tx.textContent = String(goal);') && core.includes('gc.appendChild(tx);'), 'the goal chip gets the goal text');
});

test('structure: things that act are native buttons, not clickable spans or divs', () => {
  for (const sel of ['class="chip locale" id="locale-chip"', 'class="chip" id="goal-chip"', 'class="wsadd" id="ws-add"']) {
    assert.ok(body.includes(`<button type="button" ${sel}`), `${sel} is a <button>`);
  }
  assert.equal((body.match(/<div class="ex"/g) || []).length, 0, 'no clickable suggestion divs in the static markup');
  assert.equal((JS.match(/'<div class="ex"/g) || []).length, 0, 'nor in the rebuilt welcome card');
  assert.equal((JS.match(/role="button"/g) || []).length, 0, 'nothing falls back to ARIA buttons');
  // rows built in JS
  for (const [needle, why] of [
    ["var row = document.createElement('button');\n      row.type = 'button';\n      row.className = 'mp-row' +", 'model rows switch the route'],
    ["var main = document.createElement('button'); main.type = 'button'; main.className = 'wmain';", 'workspace rows switch the workspace'],
    ["var up = document.createElement('button');", 'the picker has an up button'],
    ["var item = document.createElement('button');\n        item.type = 'button';\n        item.className = 'wsp-item';", 'picker folders are buttons'],
    ["var chip = document.createElement('button');\n      chip.type = 'button';\n      chip.className = 'deliv';", 'deliverable chips open the preview'],
  ] as Array<[string, string]>) {
    assert.ok(JS.includes(needle), why);
  }
  // the picker is a sibling of its trigger: a button may not contain interactive content
  assert.ok(!JS.includes('chip.appendChild(pick);'), 'the model picker is not inside its button');
});

test('structure: the tab strip is a real tablist (roving tabindex, arrow keys, selected state)', () => {
  assert.ok(body.includes('<div id="rtabs" role="tablist" aria-label='), 'tablist');
  assert.equal((body.match(/class="rtab[^"]*" role="tab"/g) || []).length, 5, 'five tabs carry role=tab');
  assert.equal((body.match(/role="tabpanel" aria-labelledby="rtab-\w+" tabindex="0"/g) || []).length, 5, 'five labelled, keyboard-scrollable panels');
  assert.ok(JS.includes("b.setAttribute('aria-selected', on ? 'true' : 'false');") && JS.includes('b.tabIndex = on ? 0 : -1;'), 'selection state follows the tab');
  const keydown = pageFunctions(JS).size; // sanity that the scanner sees the page
  assert.ok(keydown > 40, 'page functions are parsed');
  const dock = part('dock.ts');
  assert.ok(dock.includes("document.getElementById('rtabs').addEventListener('keydown'") && dock.includes("e.key === 'ArrowRight'") && dock.includes("e.key === 'ArrowLeft'") && dock.includes("e.key === 'Home'") && dock.includes("e.key === 'End'"), 'arrow and Home/End keys move between tabs');
});

// ---------- names and language ----------

test('names: every control the script names or labels exists, and the page language follows the locale', () => {
  const ids = new Set(Array.from(body.matchAll(/ id="([^"]+)"/g)).map((m) => m[1]));
  for (const m of core.matchAll(/\b(?:named|labelled)\('([\w-]+)'/g)) {
    assert.ok(ids.has(m[1]), `#${m[1]} exists (named/labelled by setLabels)`);
  }
  assert.ok(core.includes('document.documentElement.lang = L.localeKey;'), '<html lang> follows the locale');
  assert.ok(head.includes('<html lang="zh">'), 'the document declares a language before the locale is known');
  // the visible text of the locale chip stays first in its name
  assert.ok(core.includes("(loc || 'zh') + ' · ' + L.a11yLocale"), 'the locale chip keeps its visible text in the name');
  // navigation buttons are named by their (localized) text span, so the collapsed sidebar still names them
  const navButtons = Array.from(body.matchAll(/<button class="nav[^"]*" data-view="(\w+)"(?: aria-current="page")? aria-labelledby="nav-txt-\1"><span class="ico" aria-hidden="true">/g));
  assert.equal(navButtons.length, 8, 'eight navigation buttons, decorative icons hidden');
  for (const id of ['set-locale', 'set-approval', 'set-evolve', 'set-patch']) {
    assert.ok(body.includes(`<label for="${id}" id="${id}-label">`), `#${id} has a real <label for>`);
  }
  assert.equal((body.match(/<span id="set-[\w]+-label">/g) || []).length, 0, 'no label spans left');
});

test('names: hover-only actions stay reachable by the keyboard', () => {
  assert.ok(head.includes('.sess:hover .sacts, .sess .sacts:focus-within { opacity:1; pointer-events:auto; }'), 'session actions show on focus');
  assert.ok(head.includes('.wsi:hover .wsx, .wsi .wsx:focus-visible { opacity:1; pointer-events:auto; }'), 'the remove button shows on focus');
  assert.equal((head.match(/\.sess \.sacts \{[^}]*display:none/g) || []).length, 0, 'session actions are never display:none');
  assert.ok(head.includes('#rightbar:not(.open) > * { visibility:hidden; }'), 'a closed right column leaves the tab order');
});

// ---------- IME ----------

test('IME: Enter submits only when it is not confirming a composition (Chrome/Firefox and Safari ordering)', () => {
  const m = /  function enterConfirmed\(e\) \{ (return [^\n]+) \}/.exec(core);
  assert.ok(m, 'enterConfirmed is defined in the page kernel');
  const enterConfirmed = new Function('e', m[1]) as (e: Record<string, unknown>) => boolean;
  assert.equal(enterConfirmed({ key: 'Enter', isComposing: false, keyCode: 13 }), true);
  assert.equal(enterConfirmed({ key: 'Enter', isComposing: true, keyCode: 13 }), false, 'composing');
  assert.equal(enterConfirmed({ key: 'Enter', isComposing: false, keyCode: 229 }), false, 'Safari: compositionend came first');
  assert.equal(enterConfirmed({ key: 'a', isComposing: false, keyCode: 65 }), false);
});

test('IME: every Enter handler in the page goes through enterConfirmed — none submits on the raw key', () => {
  const lines = JS.split('\n');
  let through = 0;
  lines.forEach((line, i) => {
    if (/key === 'Enter'/.test(line) && !/function enterConfirmed\(e\)/.test(line)) {
      // either the test sits on the line itself, or the key is cancelled first and the
      // composition check follows within two lines (the composer and its palette)
      const ok = /enterConfirmed\((?:e|ev)\)/.test(line) || lines.slice(i + 1, i + 3).some((l) => /enterConfirmed\((?:e|ev)\)/.test(l));
      assert.ok(ok, `line ${i + 1}: raw Enter handler -> ${line.trim().slice(0, 90)}`);
      through++;
    }
    if (/key === 'Escape'/.test(line)) {
      const guarded = /isComposing/.test(line) || lines.slice(Math.max(0, i - 4), i).some((l) => /if \(e\.isComposing\) return;/.test(l));
      assert.ok(guarded, `line ${i + 1}: Escape handler ignores the IME's own cancel -> ${line.trim().slice(0, 90)}`);
    }
  });
  // two handlers name the key and route to the check on the next line (the composer);
  // seven call sites use the check directly across the page
  assert.ok(through >= 2, 'the composer routes its raw Enter lines through the check');
  const used = (JS.match(/enterConfirmed\((?:e|ev)\)/g) || []).length;
  assert.ok(used >= 7, 'all the Enter handlers use it');
  // Shift+Enter is the newline the placeholder promises: it must stay OUTSIDE the cancelled
  // branch. Until 2026-11-26 every Enter was cancelled before the shift check, so it never came.
  const composer = part('composer.ts');
  assert.ok(composer.includes("if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) {"), 'plain Enter and Ctrl+Enter are cancelled, Shift+Enter is not');
  assert.ok(!composer.includes("if (!e.shiftKey) document.getElementById('send').click();"), 'the old shape cancelled Shift+Enter and then decided not to send');
  // and a composing Enter is cancelled too, so it cannot leave a newline behind
  assert.ok(/e\.preventDefault\(\);\n\s+if \(!enterConfirmed\(e\)\) return;/.test(composer), 'preventDefault precedes the composition check');
});

// ---------- CSS invariants ----------

test('CSS: focus stays visible — no outline is switched off without a replacement', () => {
  const css = head;
  assert.ok(css.includes(':focus-visible { outline:2px solid var(--accent); outline-offset:2px; }'), 'one focus ring for everything');
  const off = css.match(/[^\n]*outline\s*:\s*none[^\n]*/g) || [];
  assert.deepEqual(off.map((l) => l.trim()), ['#input:focus-visible { outline:none; }'], 'the only switch-off is #input, whose card highlights through :focus-within');
  assert.ok(css.includes('#inputcard:focus-within { border-color:var(--accent); }'), 'the replacement indicator exists');
});

test('CSS: viewport, color-scheme, reduced motion and forced colors', () => {
  assert.ok(head.includes('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'), 'viewport-fit=cover (the composer already pads by safe-area-inset-bottom)');
  assert.ok(head.includes('<meta name="color-scheme" content="dark light">'), 'supported schemes are declared before first paint');
  assert.ok(/:root \{[^}]*color-scheme:dark; \}/.test(head), 'the root declares its scheme');
  assert.ok(/body\[data-theme="light"\] \{[^}]*color-scheme:light; \}/.test(head) && /body\[data-theme="system"\] \{ color-scheme:light dark; \}/.test(head), 'light and system themes follow');
  assert.ok(part('chrome.ts').includes("document.documentElement.style.colorScheme = mode === 'light' ? 'light' : mode === 'system' ? 'light dark' : 'dark';"), 'applyTheme moves the ROOT scheme');
  assert.ok(/grid-template-rows:100vh; height:100vh; grid-template-rows:100dvh; height:100dvh; \}/.test(head), 'dvh follows the vh fallback');
  const reduce = mediaBlock(head, 'prefers-reduced-motion: reduce');
  assert.ok(/#rs-spin \{ animation-duration:6s; \}/.test(reduce) && /#approval\.pulse \{ animation:none; \}/.test(reduce) && /#log \{ scroll-behavior:auto; \}/.test(reduce), 'the infinite animations and smooth scrolling respect reduced motion');
  const forced = mediaBlock(head, 'forced-colors: active');
  assert.ok(forced.includes('outline:1px solid CanvasText') && forced.includes('.nav.on') && forced.includes('.rtab[aria-selected="true"]'), 'selected states survive forced colors');
  const coarse = mediaBlock(head, 'pointer: coarse');
  assert.ok(coarse.includes('min-block-size:32px') && coarse.includes('min-block-size:36px'), 'touch targets grow on coarse pointers');
});

test('the assembled page still parses as one script and carries no unnonced script tag', () => {
  const scripts = page.match(/<script\b[^>]*>/g) || [];
  assert.equal(scripts.length, 1, 'one inline script');
  assert.ok(scripts[0].includes('nonce="__HMH_NONCE__"'), 'with the nonce placeholder');
  assert.ok(!/outline:\s*none/.test(body.replace(/#goal-input/, '')), 'no inline outline:none in the markup');
});
