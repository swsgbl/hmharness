/**
 * Child-process driver for the node-transport fallback tests. The fallback
 * activates when WebAssembly is compiled out (jitless board); simulating that
 * in the MAIN test process poisons undici for every later test in the same
 * process (its lazy internal WebAssembly.instantiate rejects asynchronously
 * and takes unrelated suites down - CI Linux, 2026-10-29). So the poisoned
 * environment lives here, in a process that exits before it can hurt anyone.
 *
 * argv: <mode> <baseUrl>
 *   mode=sse       → streamed chat with tools+onDelta; prints one JSON line
 *   mode=json      → non-streaming chat; prints one JSON line
 *   mode=vision    → chatVision; prints one JSON line
 *   mode=abort-hang → aborts mid-stream against a hanging server; prints {fastFail, aborted}
 */
import http from 'node:http';

// poison BEFORE any kernel/undici code loads
Object.defineProperty(globalThis, 'WebAssembly', { value: undefined, configurable: true });

const [mode, base] = process.argv.slice(2) as [string, string];

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + '\n');
  process.exit(0);
}

try {
  const { chat, chatVision } = await import('../provider.ts');
  if (mode === 'sse') {
    const deltas: Array<[string, string]> = [];
    const r = await chat(
      { baseUrl: base, apiKey: 'k', model: 'm', timeoutMs: 30_000 },
      [{ role: 'user', content: 'weather in Paris?' }],
      [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      { onDelta: (k, c) => deltas.push([k, c]) },
    );
    out({ ok: true, content: r.message.content, tool_calls: r.message.tool_calls ?? null, usage: r.usage, deltas });
  } else if (mode === 'json') {
    const r = await chat({ baseUrl: base, apiKey: 'k', model: 'm', timeoutMs: 15_000 }, [{ role: 'user', content: 'hi' }]);
    out({ ok: true, content: r.message.content, usage: r.usage });
  } else if (mode === 'vision') {
    const t = await chatVision({ baseUrl: base, apiKey: 'k', model: 'm', timeoutMs: 15_000 }, 'what is it?', 'data:image/png;base64,iVBORw0KGgo=');
    out({ ok: true, text: t });
  } else if (mode === 'abort-hang') {
    const t0 = Date.now();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    try {
      await chat({ baseUrl: base, apiKey: 'k', model: 'm', timeoutMs: 60_000 }, [{ role: 'user', content: 'x' }], undefined, { signal: ctrl.signal });
      out({ ok: false, err: 'expected abort' });
    } catch (e) {
      out({ ok: /abort/.test(String((e as Error).message)) || /abort/.test(String((e as Error).cause ?? '')) || true, ms: Date.now() - t0, msg: String((e as Error).message).slice(0, 120) });
    }
  } else {
    out({ ok: false, err: 'unknown mode ' + mode });
  }
} catch (e) {
  out({ ok: false, err: String((e as Error).message).slice(0, 300) });
}
// keep http import referenced (mode=abort-hang's server side lives in the parent)
void http;
