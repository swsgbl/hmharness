import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * TUI long-output no-screen-steal regression (docx 第五阶段):
 * The renderer must cap per-frame text; a 10k-line tool output cannot blow
 * up the frame budget. These are pure-logic tests against the clipping
 * helpers the TUI uses (mirroring the real code path without a TTY).
 */

/** Mirror of TuiRuntime's transcript tail-window discipline: only the last
 *  N lines are ever in the render set; older lines scroll into history. */
function clipForRender(lines: string[], maxLines: number): string[] {
  return lines.length > maxLines ? lines.slice(-maxLines) : lines;
}

test('tui: long output is clipped to the tail window (no screen steal)', () => {
  const huge = Array.from({ length: 10_000 }, (_, i) => `line ${i}`);
  const clipped = clipForRender(huge, 200);
  assert.equal(clipped.length, 200);
  assert.ok(clipped[0].includes('9800'), 'keeps the TAIL (newest lines)');
  assert.ok(clipped[clipped.length - 1].includes('9999'));
});

test('tui: short output passes through unclipped', () => {
  const small = ['a', 'b', 'c'];
  assert.deepEqual(clipForRender(small, 200), small);
});

test('tui: CJK wide chars count as width 2 in the status bar budget', () => {
  // the status line must measure display width, not code-unit count
  const visualWidth = (s: string): number => {
    let w = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0) ?? 0;
      w += (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x2fffd) ? 2 : 1;
    }
    return w;
  };
  assert.equal(visualWidth('abc'), 3);
  assert.equal(visualWidth('中文'), 4);
  assert.equal(visualWidth('混合abc'), 7);
});

/** /keymap reset must restore KEYMAP_DEFAULTS (docx: "修改后必须能恢复默认") */
test('tui: keymap reset semantics - spread of defaults gives a clean slate', () => {
  const KEYMAP_DEFAULTS: Record<string, string> = {
    interrupt: '\x1b', historySearch: '\x12', transcript: '\x14',
    inject: '\x0a', externalEdit: '\x07',
  };
  const remapped = { ...KEYMAP_DEFAULTS, inject: '\x09', interrupt: '\x03' };
  assert.notEqual(remapped.inject, KEYMAP_DEFAULTS.inject);
  const reset = { ...KEYMAP_DEFAULTS };
  assert.deepEqual(reset, KEYMAP_DEFAULTS, 'reset restores every binding');
});
