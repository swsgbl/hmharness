/**
 * RLM sandbox RED-TEAM (audit W1-2 / line F) — executable payloads, no
 * paper security. Each vector runs against the REAL worker; the verdict
 * records what actually happens. Anything that breaks out is either
 * hardened (if feasible in-worker) or documented in the threat model —
 * never silently ignored.
 *
 * Vectors probed:
 *   R1  globalThis.process          — full process object reachable?
 *   R2  process.mainModule.require  — classic CJS escape to node:fs
 *   R3  dynamic import()            — async import of node:fs
 *   R4  constructor.constructor     — fresh Function from a clean scope
 *   R5  secrets                    — host env must be absent (regression)
 *   R6  ctx prototype pollution    — vars leak/mutate into host objects?
 *   R7  network                    — fetch from inside the worker
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSandboxedEval, SANDBOX_BYPASS_VECTORS } from '../rlm-sandbox.ts';

const T = { timeoutMs: 10_000 };
type Probe = { vector: string; key: string; payload: string };

const probes: Probe[] = [
  {
    key: 'R1', vector: 'globalThis.process',
    payload: `const p = globalThis.process; return p ? 'REACHED pid=' + p.pid : 'blocked';`,
  },
  {
    key: 'R2', vector: 'process.mainModule.require',
    payload: `const p = globalThis.process; if (p && p.mainModule && p.mainModule.require) { const fs = p.mainModule.require('node:fs'); return 'ESCAPED fs.readdir=' + (typeof fs.readdir); } return 'blocked';`,
  },
  {
    key: 'R3', vector: 'dynamic import()',
    payload: `try { const fs = await import('node:fs'); return 'ESCAPED fs.readdir=' + (typeof (fs.default ?? fs).readdir); } catch (e) { return 'blocked: ' + String(e).slice(0, 60); }`,
  },
  {
    key: 'R4', vector: 'constructor.constructor',
    payload: `try { const F = ({}).constructor.constructor; const f = F('return globalThis.process'); const p = f(); return p ? 'ESCAPED via ctor pid=' + p.pid : 'blocked(null)'; } catch (e) { return 'blocked: ' + String(e).slice(0, 60); }`,
  },
  {
    key: 'R5', vector: 'env secrets',
    payload: `const p = globalThis.process; return p && p.env && Object.keys(p.env).length > 0 ? 'LEAK keys=' + Object.keys(p.env).slice(0, 5).join(',') : 'env-empty-or-absent';`,
  },
  {
    key: 'R6', vector: 'ctx pollution',
    payload: `try { ctx.vars.extra = 1; return 'MUTATED'; } catch (e) { return 'frozen: ' + e.constructor.name; }`,
  },
  {
    key: 'R7', vector: 'network fetch global',
    payload: `return typeof globalThis.fetch;`,
  },
  {
    key: 'R8', vector: 'Worker spawn global',
    payload: `return typeof globalThis.Worker;`,
  },
];

test('redteam: hardened vectors BLOCKED; any escape must be a DECLARED bypass', async () => {
  process.env.HMH_REDTEAM_PROBE = 'secret-value-xyz';
  const verdicts: Array<{ key: string; vector: string; result: string }> = [];
  try {
    for (const p of probes) {
      const r = await runSandboxedEval(p.payload, { x: 1 }, {}, T);
      const result = r.ok ? String(r.value) : `${r.error?.code}: ${r.error?.message?.slice(0, 50)}`;
      verdicts.push({ key: p.key, vector: p.vector, result });
      console.log(`  ${p.key} ${p.vector.padEnd(30)} -> ${result.slice(0, 70)}`);
    }
  } finally {
    delete process.env.HMH_REDTEAM_PROBE;
  }
  const byKey = (k: string) => verdicts.find((v) => v.key === k)!.result;

  // HARDENED invariants (round-32 hardening, pinned forever):
  assert.match(byKey('R1'), /^blocked/, 'globalThis.process must be stripped in the worker');
  assert.match(byKey('R4'), /^blocked/, 'constructor.constructor must reach a stripped process (null/undefined), not a live one');
  assert.ok(!byKey('R5').includes('secret-value-xyz') && !byKey('R5').startsWith('LEAK'), 'host secrets must never be readable');
  assert.match(byKey('R6'), /frozen/, 'ctx must stay frozen');
  assert.equal(byKey('R7'), 'undefined', 'fetch global must be stripped in the eval scope');
  assert.equal(byKey('R8'), 'undefined', 'Worker global must be stripped in the eval scope');

  // BYPASS discipline: every vector that STILL escapes must be declared in
  // SANDBOX_BYPASS_VECTORS (normalized matching: hyphens vs spaces); an
  // undeclared escape fails CI here.
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const escaping = verdicts.filter((v) => /^ESCAPED|^REACHED|^LEAK|^MUTATED/.test(v.result));
  for (const esc of escaping) {
    const declared = SANDBOX_BYPASS_VECTORS.some((b) => norm(esc.vector).includes(norm(b)) || norm(b).includes(norm(esc.key)));
    assert.ok(declared, `ESCAPE via ${esc.vector} is NOT declared in SANDBOX_BYPASS_VECTORS — harden it or declare it: ${esc.result}`);
  }
  // and the declared bypass must actually be real (no theater):
  assert.ok(escaping.length >= 1, 'the declared bypass list must reflect real, still-escaping vectors');
});

test('redteam: crash containment still holds under hostile payloads', async () => {
  const bombs = [
    'null.x.y.z',
    'return (function f(){return f()})()',
    'const a=[]; while(true) a.push(new Array(10000));',
    'throw new Error("hostile")',
  ];
  for (const bomb of bombs) {
    const r = await runSandboxedEval(bomb, {}, {}, { timeoutMs: 3_000 });
    assert.equal(r.ok, false, `bomb "${bomb.slice(0, 24)}" must not succeed`);
    // host stays alive: the next eval still works
    const ok = await runSandboxedEval('return 1;', {}, {}, T);
    assert.equal(ok.value, 1);
  }
});
