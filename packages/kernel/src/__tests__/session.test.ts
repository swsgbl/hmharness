import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSessionFile, latestSession, listSessions, loadTranscript, readSessionHead, Session } from '../session.ts';

test('loadTranscript rebuilds messages with tool_call_id pairing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-sess-'));
  try {
    await mkdir(join(dir, 'sessions'), { recursive: true });
    const lines = [
      JSON.stringify({ t: 'session/start', id: 's1', time: 't', cwd: 'c', model: 'm' }),
      JSON.stringify({ t: 'user', time: 't', text: 'list files' }),
      JSON.stringify({ t: 'assistant', time: 't', text: null, tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
        { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } },
      ] }),
      JSON.stringify({ t: 'tool', time: 't', name: 'list_dir', output: 'dir listing', isError: false }),
      JSON.stringify({ t: 'tool', time: 't', name: 'read_file', output: 'file content', isError: false }),
      JSON.stringify({ t: 'assistant', time: 't', text: 'done' }),
      JSON.stringify({ t: 'approval', time: 't', tool: 'x', granted: true }),
      JSON.stringify({ t: 'final', time: 't', text: 'done', turns: 2, toolUses: 2 }),
    ].join('\n');
    const file = join(dir, 'sessions', 's1.jsonl');
    await writeFile(file, lines, 'utf8');

    const tr = await loadTranscript(file);
    assert.equal(tr?.id, 's1');
    assert.equal(tr?.messages.length, 5);
    const toolMsgs = tr!.messages.filter((m) => m.role === 'tool');
    assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['call_a', 'call_b']);
    assert.equal(toolMsgs[1].name, 'read_file');

    assert.equal(await latestSession(dir, 's'), file);
    assert.equal(await latestSession(dir, 'nope'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Session appends events to its jsonl file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-sess2-'));
  try {
    const s = Session.create(dir, 'cwd', 'model');
    await s.user('hello');
    await s.tool('list_dir', 'out', false);
    await s.approval('run_command', false);
    await s.final('text', 1, 1);
    const raw = await readFile(s.file, 'utf8');
    const events = raw.trim().split('\n').map((l) => JSON.parse(l) as { t: string });
    assert.deepEqual(events.map((e) => e.t), ['session/start', 'user', 'tool', 'approval', 'final']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('new rollouts land in date-nested dirs with git context in session_meta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-sess3-'));
  try {
    // a plain git repo branch via .git/HEAD (kernel reads it zero-dep)
    await mkdir(join(dir, 'repo', '.git'), { recursive: true });
    await writeFile(join(dir, 'repo', '.git', 'HEAD'), 'ref: refs/heads/feature/x\n', 'utf8');
    const s = Session.create(dir, join(dir, 'repo'), 'm');
    await s.user('nested?');
    assert.match(s.file.replace(/\\/g, '/'), /sessions\/\d{4}\/\d{2}\/\d{2}\/[^/]+\.jsonl$/);
    const head = await readSessionHead(s.file);
    assert.equal(head?.git?.branch, 'feature/x');
    assert.equal(head?.firstUser, 'nested?');
    // outside any repo: no git key at all
    const s2 = Session.create(dir, dir, 'm');
    const head2 = await readSessionHead(s2.file);
    assert.equal(head2?.git, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Session.resume appends to the same rollout without a second session/start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-sess4-'));
  try {
    const s = Session.create(dir, 'cwd', 'm');
    await s.user('first turn');
    const again = await Session.resume(dir, s.id);
    assert.ok(again);
    assert.equal(again.id, s.id);
    assert.equal(again.file, s.file);
    await again.user('second turn');
    const raw = await readFile(s.file, 'utf8');
    const events = raw.trim().split('\n').map((l) => JSON.parse(l) as { t: string; text?: string });
    assert.deepEqual(events.map((e) => e.t), ['session/start', 'user', 'user']);
    // torn-tail guard: a file without trailing newline still resumes cleanly
    await writeFile(s.file, raw.trimEnd(), 'utf8');
    const byPrefix = await findSessionFile(dir, s.id.slice(0, 10));
    assert.ok(byPrefix);
    const third = await Session.resume(dir, byPrefix);
    assert.ok(third);
    await third.user('third');
    const raw3 = await readFile(s.file, 'utf8');
    assert.equal(raw3.trim().split('\n').length, 4);
    // unknown prefix -> null (caller falls back to a fresh session)
    assert.equal(await Session.resume(dir, '2099-01-01T00-00-00-nope'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listSessions: mixed layouts, sort keys, cwd filter, cursor pagination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-sess5-'));
  try {
    // legacy flat file (older)
    await mkdir(join(dir, 'sessions'), { recursive: true });
    await writeFile(
      join(dir, 'sessions', '2026-01-01T10-00-00-old1.jsonl'),
      JSON.stringify({ t: 'session/start', id: '2026-01-01T10-00-00-old1', time: '2026-01-01T10:00:00Z', cwd: '/w/alpha', model: 'm' }) + '\n'
        + JSON.stringify({ t: 'user', time: 'x', text: 'legacy alpha task' }) + '\n',
      'utf8',
    );
    // nested new file (newer)
    const s = Session.create(dir, '/w/beta', 'm');
    await s.user('nested beta task');
    const older = join(dir, 'sessions', '2026-01-01T10-00-00-old1.jsonl');
    // deterministic updated-at: legacy mtime newest, nested created newest
    await utimes(s.file, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
    await utimes(older, new Date('2026-07-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'));

    // updated sort: legacy (July) first
    const byUpdated = await listSessions(dir, { sort: 'updated' });
    assert.deepEqual(byUpdated.items.map((i) => i.id.endsWith('old1') ? 'legacy' : 'nested'), ['legacy', 'nested']);
    assert.equal(byUpdated.items[0].title, 'legacy alpha task');

    // created sort: nested (today) first
    const byCreated = await listSessions(dir, { sort: 'created' });
    assert.deepEqual(byCreated.items.map((i) => i.id.endsWith('old1') ? 'legacy' : 'nested'), ['nested', 'legacy']);

    // cwd filter
    const betaOnly = await listSessions(dir, { cwd: '/w/beta' });
    assert.equal(betaOnly.items.length, 1);
    assert.equal(betaOnly.items[0].title, 'nested beta task');

    // cursor pagination: page of 1 then continue past the anchor
    const p1 = await listSessions(dir, { sort: 'updated', limit: 1 });
    assert.equal(p1.items.length, 1);
    assert.ok(p1.nextCursor);
    const p2 = await listSessions(dir, { sort: 'updated', limit: 1, cursor: p1.nextCursor! });
    assert.equal(p2.items.length, 1);
    assert.notEqual(p2.items[0].id, p1.items[0].id);
    assert.equal(p2.nextCursor, null);

    // trash/archive dirs are invisible
    await mkdir(join(dir, 'sessions', 'trash'), { recursive: true });
    await writeFile(join(dir, 'sessions', 'trash', 'gone.jsonl'), '{}\n', 'utf8');
    const all = await listSessions(dir, {});
    assert.equal(all.items.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('latestSession resolves ids across nested and flat layouts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-sess6-'));
  try {
    const s = Session.create(dir, 'cwd', 'm');
    await s.user('hi');
    assert.equal(await latestSession(dir, s.id), s.file);
    assert.equal(await latestSession(dir, s.id.slice(0, 13)), s.file);
    assert.equal(await latestSession(dir, 'zzz'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
