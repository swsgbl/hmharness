/**
 * @hmharness/browser - page expressions (snapshot / read / act)
 *
 * The DOM side of the CDP driving, as pure string builders + parsers so
 * they are unit-testable without a browser. Interaction targets use
 * data-hmh-ref attributes STAMPED INTO the DOM by the snapshot: refs stay
 * stable between snapshot and click/type, survive DOM reads, and are
 * visible to the user in DevTools when debugging a stuck agent.
 */
export interface SnapshotElement {
  ref: number;
  tag: string;
  role?: string;
  text?: string;
  placeholder?: string;
  value?: string;
  href?: string;
}

export interface Snapshot {
  title: string;
  url: string;
  elements: SnapshotElement[];
}

/** Stamp [data-hmh-ref] onto visible interactive elements and return the
 *  serialized snapshot. Cap 80 elements — a longer list stops paying for
 *  its own tokens. Password VALUES are never read back. */
export const SNAPSHOT_EXPR = `(() => {
  for (const el of document.querySelectorAll('[data-hmh-ref]')) el.removeAttribute('data-hmh-ref');
  const sels = 'a[href], button, input, select, textarea, summary, [role], [contenteditable="true"], [onclick], [tabindex]';
  const nodes = Array.from(document.querySelectorAll(sels));
  const out = [];
  let ref = 0;
  for (const el of nodes) {
    if (out.length >= 80) break;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || st.visibility === 'hidden' || st.display === 'none') continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    ref += 1;
    el.setAttribute('data-hmh-ref', String(ref));
    const e = { ref: ref, tag: el.tagName.toLowerCase() };
    const role = el.getAttribute('role');
    if (role) e.role = role;
    const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    if (t) e.text = t;
    const ph = el.getAttribute('placeholder');
    if (ph) e.placeholder = ph.slice(0, 60);
    const kind = el.getAttribute('type');
    if ((el.tagName === 'INPUT' && kind !== 'password' || el.tagName === 'TEXTAREA') && el.value) e.value = String(el.value).slice(0, 60);
    const href = el.getAttribute('href');
    if (href) e.href = href.slice(0, 120);
    out.push(e);
  }
  return JSON.stringify({ title: document.title, url: location.href, elements: out });
})()`;

/** Page text for reading (innerText keeps visual order; capped for context). */
export const READ_EXPR = `(() => {
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n');
  return JSON.stringify({ title: document.title, url: location.href, text: text.slice(0, 12000), truncated: text.length > 12000 });
})()`;

export interface ReadResult {
  title: string;
  url: string;
  text: string;
  truncated?: boolean;
}

/** the querySelector string for a snapshot ref (ref is a validated
 *  integer, so single-quote wrapping needs no escaping) */
function refQuery(ref: number): string {
  return `'[data-hmh-ref="${ref}"]'`;
}

/** Click a snapshot ref (scrolls into view first). */
export function clickExpr(ref: number): string {
  return `(() => { const el = document.querySelector(${refQuery(ref)}); if (!el) return 'E_NO_REF'; el.scrollIntoView({ block: 'center' }); el.click(); return 'ok'; })()`;
}

/** Type into a snapshot ref — native value setter + input/change events
 *  (React/Vue-compatible), optional submit via form.requestSubmit(). */
export function typeExpr(ref: number, text: string, submit = false): string {
  return `(() => { const el = document.querySelector(${refQuery(ref)}); if (!el) return 'E_NO_REF'; el.focus(); el.scrollIntoView({ block: 'center' });
  const value = ${JSON.stringify(text)};
  if (el.isContentEditable) { el.textContent = value; }
  else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, value); else el.setAttribute('value', value);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (${submit ? 'true' : 'false'}) {
    const form = el.closest('form');
    if (form) form.requestSubmit(); else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  return 'ok'; })()`;
}

/** Scroll: down|up|top|bottom (default 600px steps). */
export function scrollExpr(direction: string, amount = 600): string {
  const d = ['down', 'up', 'top', 'bottom'].includes(direction) ? direction : 'down';
  if (d === 'top') return `(() => { window.scrollTo(0, 0); return 'ok:' + Math.round(window.scrollY); })()`;
  if (d === 'bottom') return `(() => { window.scrollTo(0, document.body.scrollHeight); return 'ok:' + Math.round(window.scrollY); })()`;
  const delta = d === 'up' ? -amount : amount;
  return `(() => { window.scrollBy(0, ${delta}); return 'ok:' + Math.round(window.scrollY); })()`;
}

/** Parse + validate a snapshot payload from the page. */
export function parseSnapshot(raw: unknown): Snapshot {
  if (typeof raw !== 'string') throw new Error('snapshot returned no JSON');
  const j = JSON.parse(raw) as Snapshot;
  if (!j || !Array.isArray(j.elements)) throw new Error('snapshot payload malformed');
  return j;
}

/** Parse + validate a read payload from the page. */
export function parseRead(raw: unknown): ReadResult {
  if (typeof raw !== 'string') throw new Error('read returned no JSON');
  const j = JSON.parse(raw) as ReadResult;
  if (!j || typeof j.text !== 'string') throw new Error('read payload malformed');
  return j;
}

/** Human/model-readable snapshot rendering. */
export function formatSnapshot(s: Snapshot): string {
  const lines = s.elements.map((e) => {
    const bits: string[] = [`[${e.ref}]`, e.tag];
    if (e.role) bits.push(`role=${e.role}`);
    if (e.text) bits.push(JSON.stringify(e.text));
    if (e.placeholder) bits.push(`placeholder=${JSON.stringify(e.placeholder)}`);
    if (e.value) bits.push(`value=${JSON.stringify(e.value)}`);
    if (e.href) bits.push(`-> ${e.href}`);
    return '  ' + bits.join(' ');
  });
  const head = `${s.title}\n${s.url}\n${s.elements.length} interactive elements (refs are stable until the page changes; re-snapshot after navigation)`;
  return head + (lines.length ? '\n' + lines.join('\n') : '\n  (none found)');
}
