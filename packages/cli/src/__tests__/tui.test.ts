import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, matchCommands, parseWheel } from '../tui.ts';

test('parseWheel decodes SGR wheel-up and wheel-down', () => {
  // wheel-up press and release forms; 64 = up, 65 = down
  assert.equal(parseWheel('\x1b[<64;12;4M'), -1);
  assert.equal(parseWheel('\x1b[<64;12;4m'), -1);
  assert.equal(parseWheel('\x1b[<65;12;4M'), 1);
  // clicks (0/1/2 with M), drag motion (32+), plain keys, empty -> 0
  assert.equal(parseWheel('\x1b[<0;12;4M'), 0);
  assert.equal(parseWheel('\x1b[<32;12;4M'), 0);
  assert.equal(parseWheel('a'), 0);
  assert.equal(parseWheel(''), 0);
  assert.equal(parseWheel('\x1b[A'), 0);
});

test('matchCommands filters by prefix and only for slash input', () => {
  assert.equal(matchCommands('hello').length, 0);
  assert.equal(matchCommands('').length, 0);
  const all = matchCommands('/');
  assert.equal(all.length, COMMANDS.length);
  const ops = matchCommands('/ops');
  assert.deepEqual(ops.map((c) => c.name), ['/ops', '/ops scan']);
  const one = matchCommands('/be');
  assert.deepEqual(one.map((c) => c.name), ['/bench']);
  // every command is reachable by its own full name (tab-complete target)
  for (const c of COMMANDS) {
    assert.equal(matchCommands(c.name)[0].name, c.name);
  }
});
