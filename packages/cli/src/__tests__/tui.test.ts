import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, matchCommands, parseWheel, nextLocale } from '../tui.ts';
import type { TuiRuntime } from '../tui.ts';

test('nextLocale: explicit zh/en wins, bare /lang toggles', () => {
  assert.equal(nextLocale('zh', ''), 'en');
  assert.equal(nextLocale('en', ''), 'zh');
  assert.equal(nextLocale('zh', 'en'), 'en');
  assert.equal(nextLocale('en', 'ZH'), 'zh');   // case-insensitive explicit
  assert.equal(nextLocale('zh', 'en '), 'en');  // trailing space from slice
  assert.equal(nextLocale('zh', 'fr'), 'en');   // unknown arg falls back to toggle
});

test('COMMANDS exposes /lang alongside /model', () => {
  const names = matchCommands('/lang').map((c) => c.name);
  assert.deepEqual(names, ['/lang']);
  assert.equal(COMMANDS.some((c) => c.name === '/lang'), true);
});

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
    // single-menu guarantee: the transcript must NOT also print a static
    // provider listing (the two-menus regression the user caught)
    assert.equal(/z-ai — /.test(p.transcript), false);
  } finally { h.restore(); }
});

test('slash-palette route: selecting the /model command opens ONLY the live picker', async () => {
  // entering via the slash palette (type '/', pick the /model row, Enter)
  // must behave exactly like typing /model + Enter: picker open, no static
  // list printed into the transcript - one menu, whichever way you came in
  const h = await makeTui();
  try {
    h.rt.openModelPicker();
    const p = h.rt.paletteProbe();
    assert.equal(p.input, '/model ');
    assert.equal(p.rows.length >= 3, true);
    assert.equal(/— .* \(/.test(p.transcript), false); // no static listing rows
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

test('picker: SS3 application-mode arrows (\x1bOA/\x1bOB) still navigate', async () => {
  // a previous program may leave the terminal in DECCKM mode; those arrows
  // arrive as SS3 and were silently dropped before normalization
  const h = await makeTui();
  try {
    h.rt.openModelPicker();
    h.keys('\x1bOB'); h.keys('\x1bOB');      // down, down via SS3
    assert.equal(h.rt.paletteProbe().selected, 2);
    h.keys('\x1bOA');                        // up via SS3
    assert.equal(h.rt.paletteProbe().selected, 1);
  } finally { h.restore(); }
});

test('picker: mouse reporting on while open, off after close (modal)', async () => {
  const h = await makeTui();
  try {
    h.rt.openModelPicker();
    h.rt.render();
    assert.equal(h.rt.paletteProbe().mouse, true);   // modal capture active
    h.keys('\x1b');                                   // Esc closes
    h.rt.render();
    assert.equal(h.rt.paletteProbe().mouse, false);  // native selection back
  } finally { h.restore(); }
});

test('picker: clicking a row selects and confirms it', async () => {
  const h = await makeTui();
  try {
    h.rt.openModelPicker();
    h.rt.render();                                    // records click rows
    const p = h.rt.paletteProbe();
    assert.equal(p.clickRows.length > 0, true);
    const target = p.clickRows[2];
    assert.equal(p.rows[target.idx], 'nvidia-vision');
    h.keys(`\x1b[<0;3;${target.row}M`);               // SGR click on that row
    assert.deepEqual(h.submitted, ['/model nvidia-vision']);
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

test('header status tells the truth: idle when calm, running while busy', async () => {
  // the header used to show "idle" permanently - even mid-task. It must
  // mirror the real state (mode tag rides along in both states).
  const h = await makeTui();
  try {
    let p = h.rt.paletteProbe();
    assert.match(p.frameText, /○ 空闲/);
    h.rt.setBusy(true);
    p = h.rt.paletteProbe();
    assert.match(p.frameText, /运行中…/);
    assert.doesNotMatch(p.frameText, /○ 空闲/);   // no lying "idle" while busy
    h.rt.setModeTag('🔥');
    p = h.rt.paletteProbe();
    assert.match(p.frameText, /运行中… 🔥/);      // mode tag stays visible
    h.rt.setBusy(false);
    p = h.rt.paletteProbe();
    assert.match(p.frameText, /○ 空闲 🔥/);
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
