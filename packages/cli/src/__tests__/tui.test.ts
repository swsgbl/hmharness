import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, matchCommands, parseWheel, nextLocale, atToken, histMatches, shellBang, forkArm, lastUserIdx, renderStatusline, parseKeySpec } from '../tui.ts';
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

test('header is a pure identity strip: no status word at all, run state only above the input box', async () => {
  // T1-v2 (user overturned T1's leftover): when the run indicator moved
  // to the input-box status line (0df4ba7), the old header slot kept a
  // stale "idle" - an orphan status. Moving a thing means deleting it from
  // where it was. Header shows identity (+mode tag); the status line is
  // the ONLY live run indicator, hidden when idle.
  const h = await makeTui();
  try {
    let p = h.rt.paletteProbe();
    assert.doesNotMatch(p.frameText, /空闲|idle/);  // no status word in header
    h.rt.setBusy(true);
    p = h.rt.paletteProbe();
    assert.match(p.frameText, /运行中…/);          // status line speaks
    assert.doesNotMatch(p.frameText, /空闲|idle/);  // header stays identity-only
    h.rt.setModeTag('🔥');
    p = h.rt.paletteProbe();
    assert.match(p.frameText, /🔥/);                // mode tag on the header
    h.rt.setBusy(false);
    p = h.rt.paletteProbe();
    assert.match(p.frameText, /🔥/);
    assert.doesNotMatch(p.frameText, /运行中…/);   // status line hidden when idle
  } finally { h.restore(); }
});

test('header shows the installed version from the first frame (user-facing build identity)', async () => {
  const h = await makeTui();
  try {
    const p = h.rt.paletteProbe();
    assert.match(p.frameText, /v\d+\.\d+\.\d+/, 'header carries vMAJOR.MINOR.PATCH');
    // and configure can replace it (version flows via configure, never hardcoded in the frame)
    h.rt.configure('m', 'd', 0, 'zh', '9.9.9');
    assert.match(h.rt.paletteProbe().frameText, /v9\.9\.9/);
  } finally { h.restore(); }
});

test('addUser: chat-style - blank line gap above/below, right-aligned against the width', async () => {
  const h = await makeTui();
  try {
    h.rt.addText('model output line');
    h.rt.addUser('你好 hmh');
    // paletteProbe.frameText FILTERS empty rows (see its impl) - the raw
    // transcript field is where blank separation is assertable
    const p = h.rt.paletteProbe();
    const plain = p.transcript.split('\n').map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''));
    const idx = plain.findIndex((l) => l.trim() === '你好 hmh');
    assert.ok(idx >= 0, 'user text renders');
    assert.ok(plain[idx].length - plain[idx].trimStart().length >= 20, 'visibly right-aligned (leading pad)');
    assert.equal(plain[idx - 1].trim(), '', 'blank line above');
    assert.equal(plain[idx + 1].trim(), '', 'blank line below');
  } finally { h.restore(); }
});

test('bare /resume + Enter submits the command; the driver opens the Codex-style modal', async () => {
  // /resume is no longer intercepted into the old palette: submitting it runs
  // the driver path that opens the full-frame picker (resume-picker.ts)
  const h = await makeTui();
  try {
    for (const ch of '/resume') h.keys(ch);
    h.keys('\r');
    assert.deepEqual(h.submitted, ['/resume']);
  } finally { h.restore(); }
});

test('resume picker modal: loads rollouts from HMH_HOME, arrows + Enter pick, Esc closes', async () => {
  const { Session } = await import('@hmharness/kernel');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'hmh-modal-'));
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = dir;
  try {
    const a = Session.create(dir, process.cwd(), 'm');
    await a.user('first alpha task');
    const b = Session.create(dir, process.cwd(), 'm');
    await b.user('second beta task');
    const h = await makeTui();
    try {
      const pickP = h.rt.openResumePicker();
      // the first page lands asynchronously - poll the rendered modal frame
      const deadline = Date.now() + 5000;
      let frame = '';
      while (Date.now() < deadline) {
        frame = h.rt.paletteProbe().frameText;
        if (frame.includes('alpha')) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.match(frame, /alpha/);
      assert.match(frame, /beta/);
      assert.match(frame, /恢复会话|Resume session/, 'title row renders');
      // updated-desc order: beta (newer) is row 0; ↓ lands on alpha, Enter picks it
      h.keys('\x1b[B');
      h.keys('\r');
      const pick = await Promise.race([pickP, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('picker never resolved')), 2000))]);
      assert.equal(pick?.kind, 'resume');
      if (pick?.kind === 'resume') assert.equal(pick.row.title, 'first alpha task');
      // reopened picker: a plain Esc (empty query) closes without a pick
      const p2 = h.rt.openResumePicker();
      await new Promise((r) => setTimeout(r, 150));
      h.keys('\x1b');
      assert.deepEqual(await p2, { kind: 'close' });
    } finally { h.restore(); }
  } finally {
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  }
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

/* ---------------- M2: runtime-steering helpers + wiring ---------------- */

test('atToken: trailing @query only, never inside slash commands', () => {
  assert.equal(atToken(''), null);
  assert.equal(atToken('read src/main'), null);
  assert.equal(atToken('look at @'), '');
  assert.equal(atToken('look at @ser'), 'ser');
  assert.equal(atToken('@packages/web/src/page.ts'), 'packages/web/src/page.ts');
  assert.equal(atToken('two @tokens @x'), 'x', 'only the trailing token counts');
  assert.equal(atToken('/resume @foo'), null, 'slash commands never @-reference');
});

test('histMatches: substring, case-insensitive, newest first, capped at 50', () => {
  const h = ['a one', 'b two', 'c one two', 'd THREE'];
  assert.deepEqual(histMatches(h, 'one'), [2, 0]);
  assert.deepEqual(histMatches(h, 'THREE'), [3]);
  assert.deepEqual(histMatches(h, ''), [3, 2, 1, 0], 'empty query = most recent 50');
  assert.deepEqual(histMatches(h, 'zzz'), []);
  const big = Array.from({ length: 80 }, (_, i) => 'task ' + i);
  assert.equal(histMatches(big, '').length, 50, 'cap at 50');
  assert.equal(histMatches(big, '')![0], 79, 'newest first');
});

test('shellBang: ! prefix extraction, empty ! is not a command', () => {
  assert.equal(shellBang('!dir /b'), 'dir /b');
  assert.equal(shellBang('  !  x'), null, 'trimmed line must START with !');
  assert.equal(shellBang('!'), null, 'bare ! has no command');
  assert.equal(shellBang('!  '), null);
  assert.equal(shellBang('echo hi'), null, 'no ! -> not a shell command');
});

test('forkArm: double-Esc within window arms, stale arm does not fire', () => {
  assert.equal(forkArm(1000, 1300, true), true, 'within 800ms');
  assert.equal(forkArm(1000, 1900, true), false, 'over 800ms');
  assert.equal(forkArm(1000, 1200, false), false, 'not armed');
});

test('lastUserIdx: finds the LAST user message (the fork point)', () => {
  const msgs = [
    { role: 'system' }, { role: 'user' }, { role: 'assistant' }, { role: 'tool' }, { role: 'user' }, { role: 'assistant' },
  ];
  assert.equal(lastUserIdx(msgs), 4);
  assert.equal(lastUserIdx([{ role: 'assistant' }]), -1);
});

test('M2 wiring: Esc while running interrupts; Ctrl+Enter while running injects', async () => {
  const h = await makeTui();
  try {
    let interrupted = 0;
    let injected: string[] = [];
    h.rt.onInterrupt(() => { interrupted++; });
    h.rt.onInject((text) => { injected.push(text); });
    // running: Esc interrupts (T9)
    h.rt.setBusy(true, 'running');
    h.keys('\x1b');
    assert.equal(interrupted, 1);
    // running + typed text: Ctrl+Enter injects (T10)
    for (const ch of 'update the readme') h.keys(ch);
    h.keys('\x0a');
    assert.deepEqual(injected, ['update the readme']);
    assert.equal(h.submitted.length, 0, 'inject must NOT go through the submit path');
    // idle: Ctrl+Enter behaves like Enter (submit)
    h.rt.setBusy(false);
    h.keys('a plain task');
    h.keys('\x0a');
    assert.deepEqual(h.submitted, ['a plain task']);
  } finally { h.restore(); }
});

test('M2 wiring: Esc Esc (idle + empty) arms edit-and-fork; Esc with a draft clears it', async () => {
  const h = await makeTui();
  try {
    let forkEdits = 0;
    h.rt.onForkEdit(() => { forkEdits++; });
    h.rt.setLastUserText('the last task');
    // first Esc (idle + empty) arms; second within 800ms fires fork-edit
    h.keys('\x1b');
    h.keys('\x1b');
    assert.equal(forkEdits, 1);
    // a draft is cleared by Esc, NOT forked (T7)
    for (const ch of 'draft text') h.keys(ch);
    h.keys('\x1b');
    assert.equal(h.rt.paletteProbe().input, '', 'Esc clears the draft');
    assert.equal(forkEdits, 1, 'no fork from a non-empty draft');
  } finally { h.restore(); }
});

/* ---------------- M4: P1 command family + cells + streaming markdown ---------------- */

test('COMMANDS covers the M4 P1 family and every key exists in both locales', async () => {
  const { strings } = await import('@hmharness/agent');
  const names = COMMANDS.map((c) => c.name);
  for (const cmd of ['/compact', '/diff', '/new', '/fork', '/copy', '/plan', '/goal', '/usage', '/review']) {
    assert.ok(names.includes(cmd), `${cmd} must be in COMMANDS`);
  }
  // C1: every command's desc key must resolve in zh AND en (no "undefined")
  const zh = strings('zh') as unknown as Record<string, unknown>;
  const en = strings('en') as unknown as Record<string, unknown>;
  for (const c of COMMANDS) {
    assert.ok(c.key in zh, `zh missing key ${c.key}`);
    assert.ok(c.key in en, `en missing key ${c.key}`);
    assert.notEqual(zh[c.key], undefined);
    assert.notEqual(en[c.key], undefined);
  }
});

test('mdColor: headings cyan-bold, fences/lists/blockquotes dim, prose plain', async () => {
  const { TuiRuntime } = await import('../tui.ts');
  assert.match(TuiRuntime.mdColor('# Title'), /\x1b\[36m\x1b\[1m# Title/);
  assert.match(TuiRuntime.mdColor('```ts'), /\x1b\[2m/);
  assert.match(TuiRuntime.mdColor('- item'), /\x1b\[2m/);
  assert.match(TuiRuntime.mdColor('> quote'), /\x1b\[2m/);
  assert.equal(TuiRuntime.mdColor('plain prose line'), 'plain prose line');
});

test('M4 cell: addToolCell folds to one line; toggleLastCell expands to the full output; z key drives it', async () => {
  const h = await makeTui();
  try {
    h.rt.addToolCell('  ● tool ⎿ first line', 'line one\nline two\nline three');
    let p = h.rt.paletteProbe();
    assert.match(p.transcript, /first line/);
    assert.ok(!p.transcript.includes('line two'), 'folded: full output hidden');
    // z with empty input expands the last cell
    h.keys('z');
    p = h.rt.paletteProbe();
    assert.ok(p.transcript.includes('line two') && p.transcript.includes('line three'), 'z expands to full output');
    // z again collapses back
    h.keys('z');
    p = h.rt.paletteProbe();
    assert.ok(!p.transcript.includes('line two'), 'z toggles back to folded');
    // with a draft, z is just typing
    h.keys('zz');
    assert.equal(h.rt.paletteProbe().input, 'zz');
  } finally { h.restore(); }
});

test('B5/B9 wiring: Ctrl+T opens the transcript overlay (with folded-away full outputs); q/Esc closes; showOverlay is the pager base', async () => {
  const h = await makeTui();
  try {
    h.rt.addToolCell('  ● tool ⎿ summary line', 'FULL-OUTPUT-ONE\nFULL-OUTPUT-TWO');
    // the driver registers the folded-away FULL tool logs as the overlay
    // source (production contract, tui.ts driver wiring) - entries only
    // contribute their (folded) transcript lines
    h.rt.setOverlaySource(() => ['FULL-OUTPUT-ONE', 'FULL-OUTPUT-TWO']);
    // Ctrl+T opens the overlay: transcript + full tool outputs (B5)
    h.keys('\x14');
    let p = h.rt.paletteProbe();
    assert.match(p.frameText, /FULL-OUTPUT-ONE/, 'overlay shows the driver-registered full outputs');
    assert.match(p.frameText, /summary line/, 'overlay includes the folded cell summary line');
    // overlay keys scroll without closing; q closes (B5)
    h.keys('j');
    h.keys('k');
    assert.match(h.rt.paletteProbe().frameText, /FULL-OUTPUT-ONE/, 'j/k scroll but keep the overlay open');
    h.keys('q');
    assert.ok(!h.rt.paletteProbe().frameText.includes('FULL-OUTPUT-ONE'), 'q closes the overlay');
    // showOverlay: public pager entry (B9 auto-pager, M4 /diff reuse); Esc closes too
    h.rt.showOverlay('GIT DIFF', ['+ added line', '- removed line']);
    assert.match(h.rt.paletteProbe().frameText, /\+ added line/, 'pager base renders provided lines');
    h.keys('\x1b');
    assert.ok(!h.rt.paletteProbe().frameText.includes('+ added line'), 'Esc closes the pager');
  } finally { h.restore(); }
});

/* ---------------- M5: statusline template + keymap ---------------- */

test('renderStatusline: placeholders substitute; unknown tokens stay literal', () => {
  const ctx = { model: 'deepseek-flash', cwd: 'hmharness', skills: 12, mode: 'ask', queue: 3, version: '0.14.9' };
  assert.equal(renderStatusline('{model} · {cwd} · {skills}', ctx), 'deepseek-flash · hmharness · 12');
  assert.equal(renderStatusline('{queue} queued · {mode}', ctx), '3 queued · ask');
  assert.equal(renderStatusline('{nope} {model}', ctx), '{nope} deepseek-flash', 'unknown token is visible, not dropped');
  assert.equal(renderStatusline('', ctx), '');
});

test('parseKeySpec: named specs map to raw bytes; unknown specs are null', () => {
  assert.equal(parseKeySpec('ctrl+j'), '\x0a');
  assert.equal(parseKeySpec('ctrl-enter'), '\x0a');
  assert.equal(parseKeySpec('ctrl+r'), '\x12');
  assert.equal(parseKeySpec('ctrl+t'), '\x14');
  assert.equal(parseKeySpec('ctrl+g'), '\x07');
  assert.equal(parseKeySpec('esc'), '\x1b');
  assert.equal(parseKeySpec('enter'), '\r');
  assert.equal(parseKeySpec('tab'), '\t');
  assert.equal(parseKeySpec('x'), 'x');
  assert.equal(parseKeySpec('ctrl+zz'), null);
  assert.equal(parseKeySpec(''), null);
});
