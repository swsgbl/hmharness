/**
 * Security headers (2026-11-25): the web server used to answer every request —
 * the 235 KB single-page app included — with no security headers at all. These
 * tests pin the baseline headers, the per-request nonce Content Security Policy
 * on the HTML documents, and the report sink that keeps CSP regressions visible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.ts';
import { PAGE } from '../page.ts';
import {
  BASE_HEADERS, CSP_REPORT_ENDPOINT, NONCE_SLOT, PIN_PAGE, documentHeaders, newNonce, stamp, summarizeCspReport,
} from '../security-headers.ts';

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-sec-headers-'));
  // isolate EVERYTHING: homeDir() reads HMH_HOME per call, so a temp home means
  // a fresh config (loopback exposure) and never the real one
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try {
    const handle = await startServer({ port: 0, host: '127.0.0.1' });
    try {
      await fn(handle.port);
    } finally {
      await handle.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

test('document policy carries the mandatory directives and the companion headers', () => {
  const h = documentHeaders('Abc123');
  const csp = h['Content-Security-Policy'] as string;
  assert.ok(csp.includes("script-src 'nonce-Abc123' 'strict-dynamic' 'report-sample'"), 'script-src is nonce + strict-dynamic (no host allowlist, no unsafe-inline)');
  for (const d of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'", "connect-src 'self'", "img-src 'self' data:", 'report-to hmh-csp']) {
    assert.ok(csp.includes(d), `directive present: ${d}`);
  }
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), 'no blanket escape hatches');
  assert.equal(h['Reporting-Endpoints'], `hmh-csp="${CSP_REPORT_ENDPOINT}"`);
  assert.equal(h['X-Frame-Options'], 'DENY', 'clickjacking: frame-ancestors none is paired with DENY');
  assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin-allow-popups');
  for (const [k, v] of Object.entries(BASE_HEADERS)) assert.equal(h[k], v, `${k} rides along on documents`);
  assert.equal(BASE_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(BASE_HEADERS['Referrer-Policy'], 'strict-origin-when-cross-origin');
});

test('nonces are fresh, URL-safe and long enough per request', () => {
  const seen = new Set(Array.from({ length: 200 }, newNonce));
  assert.equal(seen.size, 200, 'no collisions in 200 draws');
  for (const n of seen) assert.match(n, /^[A-Za-z0-9+/]{22}==$/, '16 random bytes, base64 (24 chars)');
});

test('the developer-authored pages stamp exactly their own script tags', () => {
  // Tripwire, deliberately crude: ANY new "<script" text in a page — a real tag or a
  // string literal — must either carry the nonce slot (a tag without it is blocked by
  // the policy) or be justified here in writing.
  for (const [name, html] of [['PAGE', PAGE], ['PIN_PAGE', PIN_PAGE]] as const) {
    const scripts = html.match(/<script\b/g) ?? [];
    const slots = html.split(NONCE_SLOT).length - 1;
    assert.equal(slots, scripts.length, `${name}: every <script> carries the nonce slot (a tag without it would be blocked by the policy)`);
    assert.ok(scripts.length > 0, `${name} has a script`);
    assert.ok(!/src="https?:/.test(html), `${name} loads no third-party script`);
  }
  // one swap authorizes the tags and leaves no placeholder behind
  const out = stamp(PAGE, 'N0nce');
  assert.equal(out.split('N0nce').length - 1, PAGE.split(NONCE_SLOT).length - 1);
  assert.ok(!out.includes(NONCE_SLOT));
  assert.ok(!PIN_PAGE.includes('onclick='), 'inline event handlers are blocked by the nonce policy');
});

test('server: the app document answers with the baseline headers and a nonce CSP that matches its script tag', async () => {
  await withServer(async (port) => {
    const base = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    for (const [k, v] of Object.entries(BASE_HEADERS)) assert.equal(res.headers.get(k.toLowerCase()), v, `${k} on GET /`);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('reporting-endpoints'), `hmh-csp="${CSP_REPORT_ENDPOINT}"`);
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, 'CSP carries a nonce');
    const html = await res.text();
    assert.ok(html.includes(`<script nonce="${nonce}">`), 'the inline script wears the nonce from the header');
    assert.equal((html.match(/<script\b/g) ?? []).length, 1, 'exactly one script tag: the page loads no third-party script');
    assert.ok(!html.includes(NONCE_SLOT), 'no placeholder leaked to the client');
    assert.ok(!html.includes('cdn.jsdelivr.net'), 'the blocking CDN script is gone');

    const again = await fetch(`${base}/`);
    const nonce2 = /script-src 'nonce-([^']+)'/.exec(again.headers.get('content-security-policy') ?? '')?.[1];
    assert.ok(nonce2 && nonce2 !== nonce, 'a fresh nonce per request');
  });
});

test('server: API responses carry the baseline headers too', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(res.headers.get('content-security-policy'), null, 'the document policy is not glued onto JSON');
  });
});

test('server: CSP violation reports are accepted, malformed ones ignored', async () => {
  await withServer(async (port) => {
    const base = `http://127.0.0.1:${port}`;
    const post = (body: string) => fetch(`${base}${CSP_REPORT_ENDPOINT}`, {
      method: 'POST', headers: { 'content-type': 'application/reports+json', origin: base }, body,
    });
    assert.equal((await post(JSON.stringify({ type: 'csp-violation', age: 30, body: { effectiveDirective: 'script-src', blockedURI: 'inline', sample: 'alert(1)', lineNumber: 3 } }))).status, 204);
    assert.equal((await post('this is not json')).status, 204);
    assert.equal((await post(JSON.stringify({ hello: 'world' }))).status, 204);
  });
});

test('summarizeCspReport keeps only what identifies the cause', () => {
  assert.equal(
    summarizeCspReport({ type: 'csp-violation', age: 30, body: { effectiveDirective: 'script-src', blockedURI: 'inline', sample: 'alert(1)', lineNumber: 3, documentURI: 'http://127.0.0.1:7788/', originalPolicy: 'x'.repeat(400) } }),
    'directive=script-src blocked=inline sample="alert(1)" line=3 age=30',
  );
  assert.equal(summarizeCspReport({ 'violated-directive': 'img-src', 'blocked-uri': 'https://evil.example/x.png' }), 'directive=img-src blocked=https://evil.example/x.png');
  assert.equal(summarizeCspReport({ hello: 'world' }), null);
  assert.equal(summarizeCspReport(null), null);
});
