import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, matchCommands, parseWheel } from '../tui.ts';
import type { TuiRuntime } from '../tui.ts';

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

/* ------------- runtime-level palette tests (headless TUI) -------------
 *
 * TuiRuntime binds process.stdin/stdout at module load, so the streams are
 * stubbed BEFORE a dynamic import, and keys are fed through the real
 * stdin 'data' wiring. No terminal needed; render ticks never fire because
 * each test finishes synchronously (render runs on a 90ms interval).
 */

interface TuiHandle {
  rt: TuiRuntime;
  keys: (d: string) => void;
  submitted: string[];
  restore: () => void;
}

async function makeTui(): Promise<TuiHandle> {
  const stdin = process.stdin as unknown as Record<string, unknown>;
  const stdout = process.stdout as unknown as Record<string, unknown>;
  let keyHandler: (d: string) => void = () => {};
  const prev = {
    write: stdout.write, on: stdout.on, sinOn: stdin.on,
    setRawMode: stdin.setRawMode, resume: stdin.resume,
    setEncoding: stdin.setEncoding, pause: stdin.pause,
  };
  stdout.write = () => true;
  stdout.on = () => process.stdout;
  stdin.on = (_ev: string, fn: (d: string) => void) => { if (_ev === 'data') keyHandler = fn; return process.stdin; };
  stdin.setRawMode = () => process.stdin;
  stdin.resume = () => process.stdin;
  stdin.setEncoding = () => process.stdin;
  stdin.pause = () => process.stdin;
  try {
    const mod = await import('../tui.ts');
    const rt = new mod.TuiRuntime();
    rt.setModelChoices([
      { name: 'z-ai', desc: 'glm-4.7 (chat/vision)' },
      { name: 'freellmapi', desc: 'local (chat)' },
      { name: 'nvidia-vision', desc: 'llama-90b (vision)' },
    ]);
    const submitted: string[] = [];
    rt.onSubmit(() => { submitted.push(rt.consumeInput().trim()); });
    const restore = () => {
      rt.destroy();
      stdout.write = prev.write as typeof stdout.write;
      stdout.on = prev.on as typeof stdout.on;
      stdin.on = prev.sinOn as typeof stdin.on;
      stdin.setRawMode = prev.setRawMode as typeof stdin.setRawMode;
      stdin.resume = prev.resume as typeof stdin.resume;
      stdin.setEncoding = prev.setEncoding as typeof stdin.setEncoding;
      stdin.pause = prev.pause as typeof stdin.pause;
    };
    return { rt, keys: (d: string) => keyHandler(d), submitted, restore };
  } catch (err) {
    throw err;
  }
}

test('bare /model + Enter OPENS the picker (no command runs, no silent first-model switch)', async () => {
  const h = await makeTui();
  try {
    for (const ch of '/model') h.keys(ch);
    let p = h.rt.paletteProbe();
    assert.equal(p.rows.includes('z-ai'), true); // palette previews while typing
    h.keys('\r');
    p = h.rt.paletteProbe();
    assert.equal(p.input, '/model ');       // picker focused, space in place
    assert.equal(h.submitted.length, 0);    // driver NOT invoked
    assert.equal(p.rows.length >= 3, true); // live rows, selectable
    assert.equal(p.selected, 0);
  } finally { h.restore(); }
});

test('picker: arrows + second Enter confirm the highlighted model', async () => {
  const h = await makeTui();
  try {
    h.rt.openModelPicker();
    h.keys('\x1b[B'); h.keys('\x1b[B');      // down, down -> row 2
    let p = h.rt.paletteProbe();
    assert.equal(p.selected, 2);
    assert.equal(p.rows[2], 'nvidia-vision');
    h.keys('\r');                            // second Enter confirms
    assert.deepEqual(h.submitted, ['/model nvidia-vision']);
    assert.equal(h.rt.paletteProbe().input, ''); // input consumed
  } finally { h.restore(); }
});

test('picker: wheel moves the selection while the palette is open', async () => {
  const h = await makeTui();
  try {
    h.rt.openModelPicker();
    h.keys('\x1b[<65;10;3M');                // SGR wheel-down
    assert.equal(h.rt.paletteProbe().selected, 1);
    h.keys('\x1b[<64;10;3M');                // SGR wheel-up
    assert.equal(h.rt.paletteProbe().selected, 0);
  } finally { h.restore(); }
});

test('picker: Esc closes the palette and clears the draft', async () => {
  const h = await makeTui();
  try {
    h.rt.openModelPicker();
    h.keys('\x1b');
    const p = h.rt.paletteProbe();
    assert.equal(p.input, '');
    assert.equal(p.rows.length, 0);
  } finally { h.restore(); }
});

test('slash palette unchanged: /m + Enter runs the highlighted command', async () => {
  const h = await makeTui();
  try {
    for (const ch of '/m') h.keys(ch);
    const p = h.rt.paletteProbe();
    assert.deepEqual(p.rows, matchCommands('/m').map((c) => c.name));
    h.keys('\r');
    // first row in COMMANDS order wins ('/model' is listed before '/mcp');
    // with the new flow, submitting bare '/model' routes into the picker
    assert.deepEqual(h.submitted, [matchCommands('/m')[0].name]);
  } finally { h.restore(); }
});
