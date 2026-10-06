import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CognitiveLedger,
  appendLedgerEvent,
  loadLedger,
  ledgerPath,
} from '../ledger.ts';
import { WorldModel } from '../world-model.ts';

test('ledger: append-only invariants - monotonic seq, frozen events, no reuse', () => {
  const l = new CognitiveLedger();
  const a = l.append('belief.created', 'act:hdc-install', { confidence: 0.4, detail: 'first belief' });
  const b = l.append('prediction.made', 'act:hdc-install', { confidence: 0.4, runId: 'run-1' });
  const c = l.append('prediction.failed', 'act:hdc-install', { parentSeq: b.seq, detail: 'boom' });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(c.seq, 3);
  assert.ok(Object.isFrozen(a), 'events are frozen at append time');
  assert.throws(() => { (a as { subject: string }).subject = 'mutated'; }, 'frozen events reject mutation');
  assert.equal(l.events().length, 3);
});

test('ledger: chain() walks parentSeq lineage to the root', () => {
  const l = new CognitiveLedger();
  const made = l.append('prediction.made', 'act:build', { confidence: 0.7 });
  const failed = l.append('prediction.failed', 'act:build', { parentSeq: made.seq });
  const revised = l.append('belief.revised', 'act:build', { parentSeq: failed.seq, detail: 'discount confidence' });
  const chain = l.chain(revised.seq);
  assert.deepEqual(chain.map((e) => e.kind), ['prediction.made', 'prediction.failed', 'belief.revised']);
  // a chain that points at a MISSING parent stops honestly at what exists
  const orphan = l.append('belief.revised', 'act:other', { parentSeq: 999 });
  assert.equal(l.chain(orphan.seq).length, 1, 'orphan chain = just itself, no crash');
});

test('ledger: summary counts by kind and reports skipped corrupt lines', () => {
  const l = new CognitiveLedger();
  l.ingest(['{"seq":1,"kind":"belief.created","subject":"a"}', 'not json at all', '', '{"kind":"missing fields"}', '{"seq":2,"kind":"skill.promoted","subject":"s"}']);
  const s = l.summary();
  assert.equal(s.total, 2);
  assert.equal(s.corruptLinesSkipped, 2);
  assert.equal(s.byKind['belief.created'], 1);
  assert.equal(s.byKind['skill.promoted'], 1);
  assert.equal(s.lastSeq, 2);
});

test('ledger: persistence round-trip - append, reload, continue numbering', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cog-ledger-'));
  try {
    const first = new CognitiveLedger();
    const a = first.append('prediction.made', 'act:x', { confidence: 0.5 });
    const b = first.append('prediction.failed', 'act:x', { parentSeq: a.seq });
    await appendLedgerEvent(home, a);
    await appendLedgerEvent(home, b);
    const raw = await readFile(ledgerPath(home), 'utf8');
    assert.equal(raw.trim().split('\n').length, 2, 'one JSON object per line');
    const reloaded = await loadLedger(home);
    assert.equal(reloaded.summary().total, 2);
    const c = reloaded.append('belief.revised', 'act:x', { parentSeq: b.seq });
    assert.equal(c.seq, 3, 'numbering continues after reload');
    assert.deepEqual(reloaded.chain(c.seq).map((e) => e.kind), ['prediction.made', 'prediction.failed', 'belief.revised'], 'parentSeq survives the round-trip');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('ledger: absent file = fresh ledger; corrupt file = fresh-with-count, never a crash', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cog-ledger-'));
  try {
    const empty = await loadLedger(join(home, 'nothing'));
    assert.equal(empty.summary().total, 0);
    await mkdir(join(home, 'cognitive'), { recursive: true });
    await writeFile(ledgerPath(home), '{garbage\n', 'utf8');
    const corrupt = await loadLedger(home);
    assert.equal(corrupt.summary().total, 0);
    assert.ok(corrupt.summary().corruptLinesSkipped >= 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('ledger: world-model revise() mirrors belief.revised through the hook (v0 wiring)', () => {
  const wm = new WorldModel('terminal');
  const seen: Array<{ subject: string; detail: string }> = [];
  wm.ledger = (kind, subject, detail) => {
    assert.equal(kind, 'belief.revised');
    seen.push({ subject, detail });
  };
  // seed a belief for an actionType so revise() has something to correct:
  // two+ misses in the same error cluster are the repetition bar
  const wmAny = wm as unknown as {
    state: { beliefs: Array<{ id: string; claim: string; confidence: number; evidenceCount: number; corrections?: unknown[] }> };
  };
  wmAny.state.beliefs.push({ id: 'act:hdc-install', claim: 'hdc install usually succeeds', confidence: 0.8, evidenceCount: 5 });
  const revision = wm.revise([{ cluster: 'hdc-install/predicted-success-but-failed', misses: 3, total: 4, sampleErrors: [{ claim: 'succeeds', actual: 'fails', confidence: 0.8 }] }]);
  assert.ok(revision.rulesAdded.length >= 1, 'a correction rule landed');
  assert.equal(seen.length, 1, 'one belief.revised event per corrected belief');
  assert.equal(seen[0].subject, 'act:hdc-install');
  assert.ok(seen[0].detail.includes('discount its confidence'));
  // the hook throwing must never break the model it observes
  wm.ledger = () => { throw new Error('ledger down'); };
  const r2 = wm.revise([{ cluster: 'hdc-install/predicted-success-but-failed', misses: 4, total: 5, sampleErrors: [{ claim: 'succeeds', actual: 'fails', confidence: 0.8 }] }]);
  assert.ok(r2.rulesAdded.length >= 1, 'revision still completes when the ledger throws');
});
