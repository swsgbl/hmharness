import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApproval } from '../runner.ts';
import { defaultConfig } from '@hmh/kernel';

test('approval gate: yes / config-auto pass without a TTY; ask denies headless', async () => {
  // --yes / --yolo: every gate passes, nothing may block the loop
  const yolo = makeApproval(defaultConfig(), true);
  assert.equal(await yolo.ask('run_command', { command: 'x' }), true);
  assert.equal(await yolo.ask('write_file', { path: 'a' }), true);

  // config-level approval:'auto' behaves the same even with yes=false
  const auto = makeApproval({ ...defaultConfig(), approval: 'auto' }, false);
  assert.equal(await auto.ask('run_command', { command: 'x' }), true);

  // default 'ask' in a non-TTY (how the web server / pipes run): deny-first
  const ask = makeApproval(defaultConfig(), false);
  if (!process.stdin.isTTY) {
    assert.equal(await ask.ask('run_command', { command: 'x' }), false);
  }
});
