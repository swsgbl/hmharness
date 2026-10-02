/**
 * @hmharness/environments - tool bridges (blueprint §14/ENV-011..016)
 *
 * Turns the agent's REAL automation tools (desktop_screenshot/desktop_click/
 * desktop_type/browser_open) into Environment act bridges. Layering stays
 * clean: environments never imports the agent package — the caller injects
 * a generic `execute(toolName, args)` that dispatches into the tool
 * registry. Every bridge maps tool output to a structured ActionResult;
 * tool errors (isError) become failures with the tool's own message.
 */
import type { Action, ActionResult } from '@hmharness/cognitive';
import type { BrowserEnvOptions, DesktopEnvOptions } from './adapters.ts';

export type ToolExecute = (toolName: string, args: Record<string, unknown>) => Promise<{ output: string; isError?: boolean }>;

function toResult(action: Action, started: number): (r: { output: string; isError?: boolean }) => ActionResult {
  return (r) => ({
    actionId: action.id,
    outcome: r.isError ? 'failure' : 'success',
    error: r.isError ? { code: 'E_TOOL', message: r.output.slice(0, 300) } : undefined,
    output: r.output.slice(0, 2_000),
    durationMs: Date.now() - started,
  });
}

/** Browser act bridge: navigate→browser_open, click/type→desktop trio. */
export function browserActBridge(execute: ToolExecute, opts?: { cdpBase?: string }): NonNullable<BrowserEnvOptions['act']> {
  return async (action, _tabId) => {
    const started = Date.now();
    const done = toResult(action, started);
    switch (action.type) {
      case 'navigate':
        return done(await execute('browser_open', { url: String(action.args.url ?? '') }));
      case 'click':
        // visible-browser workflow: coordinate click through the desktop trio
        return done(await execute('desktop_click', { x: Number(action.args.x ?? 0), y: Number(action.args.y ?? 0) }));
      case 'type':
      case 'type-text':
        return done(await execute('desktop_type', { text: String(action.args.text ?? '') }));
      default:
        return { outcome: 'failure', error: { code: 'E_UNKNOWN_ACTION', message: `unknown browser action ${action.type}` } };
    }
  };
}

/** Desktop act bridge: click/type/hotkey → the desktop trio. */
export function desktopActBridge(execute: ToolExecute): NonNullable<DesktopEnvOptions['act']> {
  return async (action) => {
    const started = Date.now();
    const done = toResult(action, started);
    switch (action.type) {
      case 'desktop-click':
        return done(await execute('desktop_click', { x: Number(action.args.x ?? 0), y: Number(action.args.y ?? 0) }));
      case 'desktop-type':
        return done(await execute('desktop_type', { text: String(action.args.text ?? '') }));
      case 'desktop-hotkey': {
        // the trio has no hotkey primitive; compose: type with modifiers is
        // tool-specific, so route plain text and reject combos honestly
        const combo = String(action.args.combo ?? '');
        if (combo.includes('+')) {
          return { outcome: 'failure', error: { code: 'E_UNSUPPORTED', message: `hotkey combos need a dedicated tool; got ${combo}` } };
        }
        return done(await execute('desktop_type', { text: combo }));
      }
      default:
        return { outcome: 'failure', error: { code: 'E_UNKNOWN_ACTION', message: `unknown desktop action ${action.type}` } };
    }
  };
}
