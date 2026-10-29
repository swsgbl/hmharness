'use strict';
/** Unit tests for the board config-default injection (2026-10-29 device
 *  incident follow-up): an ABSENT web.tunnel is written as false at board
 *  install time; an EXPLICIT value (true or false) is the user's decision
 *  and is never overwritten; corrupt configs are left untouched. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  withBoardDefaults,
  ensureBoardDefaults,
} = require('../../packages/cli/board/board-defaults.cjs');

test('withBoardDefaults injects tunnel:false only where the key is absent', () => {
  assert.deepEqual(withBoardDefaults({}), { web: { tunnel: false } });
  assert.deepEqual(withBoardDefaults({ web: {} }), { web: { tunnel: false } });
  assert.deepEqual(withBoardDefaults({ web: null }), { web: { tunnel: false } });
  assert.deepEqual(withBoardDefaults({ web: { token: 'k' } }), { web: { token: 'k', tunnel: false } });
  // non-web keys ride along untouched
  assert.deepEqual(
    withBoardDefaults({ providers: { a: 1 }, theme: 'dark' }),
    { providers: { a: 1 }, theme: 'dark', web: { tunnel: false } },
  );
});

test('withBoardDefaults never overwrites an explicit value and never mutates input', () => {
  const explicitTrue = { web: { tunnel: true } };
  assert.equal(withBoardDefaults(explicitTrue), explicitTrue);
  const explicitFalse = { web: { tunnel: false, token: 'x' } };
  assert.equal(withBoardDefaults(explicitFalse), explicitFalse);
  // purity: the caller's object is left exactly as it was
  const input = { web: {} };
  withBoardDefaults(input);
  assert.deepEqual(input, { web: {} });
});

test('ensureBoardDefaults on real files: missing / written / explicit / corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmh-board-defaults-'));
  try {
    const cfg = path.join(dir, 'config.json');
    // no config yet -> nothing to do (hmh init owns creation)
    assert.equal(ensureBoardDefaults(cfg), 'missing');

    // absent web.tunnel -> injected, existing fields preserved
    fs.writeFileSync(cfg, JSON.stringify({ web: { token: 't' }, theme: 'dark' }, null, 2) + '\n');
    assert.equal(ensureBoardDefaults(cfg), 'written');
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), {
      web: { token: 't', tunnel: false },
      theme: 'dark',
    });

    // second run: the injected value is now explicit -> idempotent
    assert.equal(ensureBoardDefaults(cfg), 'explicit');

    // explicit true is the user's opt-in — kept verbatim
    fs.writeFileSync(cfg, JSON.stringify({ web: { tunnel: true } }));
    assert.equal(ensureBoardDefaults(cfg), 'explicit');
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { web: { tunnel: true } });

    // unparseable config: better no default than a destroyed config
    fs.writeFileSync(cfg, '{not json');
    assert.equal(ensureBoardDefaults(cfg), 'corrupt');
    assert.equal(fs.readFileSync(cfg, 'utf8'), '{not json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
