import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Esc three-state semantics matrix (docx TUI 专项: "Esc 永远有可预测语义").
 * The contract: in a modal, Esc closes the modal. In the composer with text,
 * Esc clears a pending multi-line continuation. While busy, Esc interrupts
 * the task. Never anything else - and the priority order is fixed.
 */

type EscContext = {
  modalOpen: boolean;
  hasPendingText: boolean;
  busy: boolean;
};

type EscAction = 'close-modal' | 'clear-pending' | 'interrupt-task' | 'noop';

/** The documented priority: modal > pending-text > busy > noop */
function escSemantics(ctx: EscContext): EscAction {
  if (ctx.modalOpen) return 'close-modal';
  if (ctx.hasPendingText) return 'clear-pending';
  if (ctx.busy) return 'interrupt-task';
  return 'noop';
}

test('esc: closes the modal first (highest priority)', () => {
  assert.equal(escSemantics({ modalOpen: true, hasPendingText: true, busy: true }), 'close-modal');
  assert.equal(escSemantics({ modalOpen: true, hasPendingText: false, busy: false }), 'close-modal');
});

test('esc: clears pending text before interrupting', () => {
  assert.equal(escSemantics({ modalOpen: false, hasPendingText: true, busy: true }), 'clear-pending');
  assert.equal(escSemantics({ modalOpen: false, hasPendingText: true, busy: false }), 'clear-pending');
});

test('esc: interrupts the running task', () => {
  assert.equal(escSemantics({ modalOpen: false, hasPendingText: false, busy: true }), 'interrupt-task');
});

test('esc: idle composer with no text is a no-op (never exits, never clears)', () => {
  assert.equal(escSemantics({ modalOpen: false, hasPendingText: false, busy: false }), 'noop');
});

test('esc: every possible context maps to exactly one action (total + deterministic)', () => {
  const actions: EscAction[] = [];
  for (const modalOpen of [false, true]) {
    for (const hasPendingText of [false, true]) {
      for (const busy of [false, true]) {
        actions.push(escSemantics({ modalOpen, hasPendingText, busy }));
      }
    }
  }
  assert.equal(actions.length, 8);
  const valid: EscAction[] = ['close-modal', 'clear-pending', 'interrupt-task', 'noop'];
  for (const a of actions) assert.ok(valid.includes(a), `invalid action ${a}`);
});
