import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestSession, loadTranscript, Session } from '../session.ts';

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
    const s = new Session(dir, 'cwd', 'model');
    await s.user('hello');
    await s.tool('list_dir', 'out', false);
    await s.approval('run_command', false);
    await s.final('text', 1, 1);
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(s.file, 'utf8');
    const events = raw.trim().split('\n').map((l) => JSON.parse(l) as { t: string });
    assert.deepEqual(events.map((e) => e.t), ['session/start', 'user', 'tool', 'approval', 'final']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
