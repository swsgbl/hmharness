/**
 * Motion layer (2026-11-25): the page's entrance effects moved from a CDN-loaded
 * GSAP to the Web Animations API (`createMotion` in uilite.ts). The function is
 * inlined into the page through Function#toString, so these tests drive the
 * SERIALIZED source the same way the page gets it — with the __name polyfill the
 * page prelude provides and fake window/document/element objects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotion, uiLiteSource } from '../uilite.ts';

interface FakeAnimation { id: string; target: FakeEl; kf: Array<Record<string, unknown>>; opt: Record<string, unknown>; cancelled: boolean; cancel(): void }
interface FakeEl { name: string; animations: FakeAnimation[]; getAnimations(): FakeAnimation[]; animate(kf: Array<Record<string, unknown>>, opt: Record<string, unknown>): FakeAnimation }

function harness(preferred = false, supported = true) {
  const calls: FakeAnimation[] = [];
  const el = (name: string): FakeEl => ({
    name, animations: [],
    getAnimations() { return this.animations; },
    animate(kf: Array<Record<string, unknown>>, opt: Record<string, unknown>) {
      const self = this;
      const a: FakeAnimation = {
        id: '', target: self, kf, opt, cancelled: false,
        cancel() { this.cancelled = true; const i = self.animations.indexOf(this); if (i >= 0) self.animations.splice(i, 1); },
      };
      self.animations.push(a); calls.push(a);
      return a;
    },
  });
  const a = el('a'), b = el('b'), c = el('c');
  let pref = preferred;
  const listeners: Array<() => void> = [];
  const win = { matchMedia: () => ({ get matches() { return pref; }, addEventListener(_ev: string, fn: () => void) { listeners.push(fn); } }) };
  const doc = { documentElement: supported ? el('root') : {}, querySelectorAll: () => [b, c] };
  // the serialized source, evaluated exactly as the page does (polyfill + declaration)
  const AN = new Function('var __name = function (fn) { return fn; };' + '\n' + createMotion.toString() + '\nreturn createMotion;')()(win, doc);
  return { AN, calls, a, b, c, setPref(v: boolean) { pref = v; listeners.forEach((fn) => fn()); } };
}

test('the serialized motion layer is self-contained page JS and registered for inlining', () => {
  const src = createMotion.toString();
  assert.ok(!/\bconst\b|\blet\b|=>|`/.test(src), 'ES5-ish only (const/let/arrows/templates would break the inline-source contract)');
  assert.ok(!/\bimport\b|\bexport\b/.test(src), 'no module syntax');
  assert.ok(!/:\s*(any|string|number)\b/.test(src), 'no TypeScript left in the serialized body');
  assert.ok(uiLiteSource().includes('function createMotion('), 'inlined into the page');
  assert.ok(uiLiteSource().includes('__name = (typeof __name'), 'the prelude polyfills __name that esbuild injects');
});

test('entrances animate opacity and the individual transform properties only', () => {
  const h = harness();
  h.AN.viewIn(h.a);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].opt.duration, 320);
  assert.deepEqual(Object.keys(h.calls[0].kf[0]).sort(), ['opacity', 'translate']);
  assert.deepEqual(Object.keys(h.calls[0].kf[1]).sort(), ['opacity', 'translate']);
  assert.equal(h.calls[0].kf[1].opacity, 1, 'ends fully visible');
  assert.equal(h.calls[0].kf[1].translate, '0 0', 'ends at rest');
  h.AN.popIn(h.a);
  assert.deepEqual(Object.keys(h.calls[1].kf[0]).sort(), ['opacity', 'scale', 'translate'], 'scale/translate compose with, never clobber, the element transform');
  h.AN.tick(h.b);
  assert.deepEqual(Object.keys(h.calls[2].kf[0]), ['scale'], 'tick is a scale pulse only');
  for (const c of h.calls) assert.deepEqual(Object.keys(c.kf[0]).filter((k) => !['opacity', 'translate', 'scale'].includes(k)), []);
});

test('animations fill backwards only: a staggered element holds its first frame through its delay, the final state is the element own style', () => {
  const h = harness();
  h.AN.stagger('.card');
  assert.deepEqual(h.calls.map((c) => [c.target.name, c.opt.delay]), [['b', 0], ['c', 40]]);
  for (const c of h.calls) assert.equal(c.opt.fill, 'backwards');
});

test('stagger with a root selects inside that root', () => {
  const h = harness();
  const root = { querySelectorAll: (s: string) => (s === '.card' ? [h.c] : []) };
  h.AN.stagger('.card', root as never);
  assert.deepEqual(h.calls.map((c) => c.target.name), ['c']);
});

test('restarting an entrance on the same element cancels only our own earlier animation', () => {
  const h = harness();
  h.AN.viewIn(h.a);
  const foreign = h.a.animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 9999 }); // e.g. a CSS-driven spinner
  foreign.id = 'css-spinner';
  h.AN.rowIn(h.a);
  assert.equal(foreign.cancelled, false, 'unrelated animations are left running');
  assert.ok(h.a.animations.includes(foreign), 'the CSS-driven animation is still on the element');
  assert.deepEqual(h.a.animations.filter((x) => x.id === 'hmh-motion').map((x) => x.kf[0].translate), ['0 8px'], 'our previous entrance was replaced by the new one');
});

test('reduced motion: no animation at all, tracked live', () => {
  const h = harness(true);
  assert.equal(h.AN.ok, false);
  h.AN.viewIn(h.a); h.AN.stagger('.card'); h.AN.popIn(h.a);
  assert.equal(h.calls.length, 0, 'static under prefers-reduced-motion: reduce');
  h.setPref(false);
  assert.equal(h.AN.ok, true);
  h.AN.viewIn(h.a);
  assert.equal(h.calls.length, 1, 'motion returns when the preference is turned off');
  h.setPref(true);
  h.AN.viewIn(h.b);
  assert.equal(h.calls.length, 1, 'and stops again without a reload');
});

test('without element.animate the page simply rests in its final state', () => {
  const h = harness(false, false);
  assert.equal(h.AN.ok, false);
  assert.doesNotThrow(() => { h.AN.viewIn(h.a); h.AN.stagger('.card'); h.AN.tick(h.b); });
  assert.equal(h.calls.length, 0);
});

test('elements that throw on animate do not break the caller', () => {
  const h = harness();
  const broken = { name: 'broken', animations: [], getAnimations(this: FakeEl) { return this.animations; }, animate() { throw new Error('not animatable'); } } as unknown as FakeEl;
  assert.doesNotThrow(() => h.AN.viewIn(broken));
  h.AN.viewIn(h.a);
  assert.equal(h.calls.length, 1, 'the next element still animates');
});
