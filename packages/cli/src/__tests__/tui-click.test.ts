/**
 * tui-click tests (2026-10-24, the v0.23.38 dead-click postmortem): a real
 * terminal reports a click as PRESS then RELEASE. v0.23.38 let the press
 * sequence fall through to key handling — the leading ESC closed the
 * palette, so clicks behaved like Esc. These tests drive the REAL onKey
 * pipeline (makeTui keys injector) with terminal-exact sequences.
 *
 * Render-timing note: click regions are populated by render() which runs on
 * a 90ms interval. paletteProbe() forces a render for the main view, but
 * the config modal has no equivalent probe. Keyboard-driven paths are
 * verified for /config; mouse region dispatch is verified for the palette
 * (where paletteProbe triggers the render that populates regions).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, configProviderRows, TuiRuntime } from '../tui.ts';

interface TuiHandle {
  rt: TuiRuntime;
  keys: (d: string) => void;
  submitted: string[];
  restore: () => void;
}

function makeTui(): TuiHandle {
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
  const rt = new TuiRuntime();
  rt.setModelChoices([
    { name: 'glm', desc: 'glm-5.3 (chat)' },
    { name: 'agnes', desc: 'agnes-3.0-flash' },
  ]);
  const submitted: string[] = [];
  rt.onSubmit(() => { submitted.push(rt.consumeInput().trim()); });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onKey = (rt as any).onKey.bind(rt);
  return {
    rt,
    keys: (d: string) => onKey(d),
    submitted,
    restore: () => {
      rt.destroy();
      stdout.write = prev.write as typeof stdout.write;
      stdout.on = prev.on as typeof stdout.on;
      stdin.on = prev.sinOn as typeof stdin.on;
      stdin.setRawMode = prev.setRawMode as typeof stdin.setRawMode;
      stdin.resume = prev.resume as typeof stdin.resume;
      stdin.setEncoding = prev.setEncoding as typeof stdin.setEncoding;
      stdin.pause = prev.pause as typeof stdin.pause;
    },
  };
}

test('THE v0.23.38 BUG: a press+release click on a palette row EXECUTES it', async () => {
  const h = await makeTui();
  try {
    h.keys('/');
    const probe = h.rt.paletteProbe(); // forces render → populates click regions
    assert.ok(probe.rows.length > 0, 'palette open');
    const first = probe.rows[0];
    // paletteProbe's render populated the regions; find the row by sweeping
    let hit = -1;
    for (let r = 0; r < 60; r++) {
      h.keys(`\x1b[<0;5;${r + 1}M\x1b[<0;5;${r + 1}m`); // press+release
      if (h.submitted.includes(first)) { hit = r; break; }
      if (h.rt.paletteProbe().input === '') { h.keys('/'); }
    }
    assert.ok(hit >= 0, `click at row ${hit} executed ${first}`);
    assert.equal(h.rt.paletteProbe().input.includes('[<'), false, 'no garbage leaked');
  } finally {
    h.restore();
  }
});

test('press-only sequence is consumed silently (never closes the palette)', async () => {
  const h = await makeTui();
  try {
    h.keys('/');
    h.rt.paletteProbe(); // force render
    h.keys('\x1b[<0;5;20M'); // ONLY the press half
    const probe = h.rt.paletteProbe();
    assert.ok(probe.rows.length > 0, 'palette still open — press did not act as Esc');
    assert.equal(probe.input.includes('[<'), false, 'press did not leak');
  } finally {
    h.restore();
  }
});

test('wheel events never land in the input', async () => {
  const h = await makeTui();
  try {
    h.rt.addText('line-a\nline-b\nline-c', 'plain');
    h.keys('\x1b[<64;10;5M');
    h.keys('\x1b[<65;10;5M');
    assert.equal(h.rt.paletteProbe().input, '', 'wheel never lands in input');
  } finally {
    h.restore();
  }
});

test('/config modal: Enter opens form, fields prefilled, navigate, type, save', async () => {
  const h = makeTui();
  try {
    h.rt.openConfigModal(configProviderRows({
      provider: { baseUrl: 'x', apiKey: 'k', model: 'm' },
      maxTurns: 25,
      providers: {
        glm: { baseUrl: 'https://open.bigmodel.cn/v4', apiKey: 'k1', model: 'glm-5.3' },
      },
      routing: { chat: 'glm' },
    } as never));
    let probe = h.rt.configProbe();
    assert.equal(probe.mode, 'list', 'list mode');
    assert.deepEqual(probe.rows, ['glm']);

    h.keys('\r');
    probe = h.rt.configProbe();
    assert.equal(probe.mode, 'form', 'form opened');
    assert.ok(probe.fields, 'fields present');
    assert.equal(probe.fields![0].value, 'glm', 'name prefilled');

    h.keys('\x1b[B'); h.keys('\x1b[B'); h.keys('\x1b[B');
    probe = h.rt.configProbe();
    assert.equal(probe.fi, 3, 'key field active');

    h.keys('abc123');
    probe = h.rt.configProbe();
    assert.equal(probe.fields![3].value, '••••••', 'typed key masked');

    const saved: Array<{ name: string; apiKey?: string }> = [];
    h.rt.onSaveProvider(async (name, patch) => {
      saved.push({ name, ...patch });
      return { ok: true, rows: [{ name, model: patch.model, baseUrl: patch.baseUrl, purposes: 'chat' }] };
    });
    h.keys('\r');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(saved.length, 1, 'save fired');
    assert.equal(saved[0].apiKey, 'abc123', 'key passed through');
    assert.equal(h.rt.configProbe().mode, 'list', 'back to list');
  } finally {
    h.restore();
  }
});

test('/config blank key keeps the stored one (patch omits apiKey)', async () => {
  const h = await makeTui();
  try {
    h.rt.openConfigModal([{ name: 'glm', model: 'glm-5.3', baseUrl: 'https://x/v4', purposes: 'chat' }]);
    h.keys('\r'); // open form
    let captured: { apiKey?: string } | null = null;
    h.rt.onSaveProvider(async (_name, patch) => { captured = patch; return { ok: true, rows: [] }; });
    h.keys('\r'); // save without touching the key
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((captured as { apiKey?: string } | null)?.apiKey, undefined, 'blank key = apiKey omitted');
  } finally {
    h.restore();
  }
});

test('COMMANDS exposes /config alongside /model', () => {
  assert.ok(COMMANDS.some((c) => c.name === '/config'));
});
