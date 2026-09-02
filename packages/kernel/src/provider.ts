/**
 * @hmh/kernel - provider
 * OpenAI-compatible chat adapter. Works with any /v1/chat/completions
 * endpoint: zhipu GLM, OpenAI, OpenRouter, NVIDIA NIM, vLLM, Ollama, ...
 * Streaming (SSE) activates when onDelta is provided; reasoning deltas are
 * surfaced separately so frontends can show the model thinking. One retry on
 * transient 429/5xx before the stream starts; mid-stream failures surface.
 */
import type { ChatMessage, ProviderConfig } from './types.ts';

export interface ChatResponse {
  message: ChatMessage;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export type DeltaKind = 'text' | 'reasoning';

export interface ChatOptions {
  timeoutMs?: number;
  /** Streaming callback; presence switches the request to stream:true. */
  onDelta?(kind: DeltaKind, chunk: string): void;
}

export async function chat(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools?: unknown[],
  opts: ChatOptions = {},
): Promise<ChatResponse> {
  const streaming = typeof opts.onDelta === 'function';
  const body: Record<string, unknown> = { model: cfg.model, messages };
  if (tools && tools.length > 0) body.tools = tools;
  if (streaming) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  // auth scheme: standard Bearer, or a custom header (some gateways such as
  // freellmapi only accept X-Api-Key). If Bearer gets a 401 we silently
  // renegotiate once with X-Api-Key - misconfigured gateways then just work.
  const mkHeaders = (scheme: 'bearer' | 'xapikey' | string) =>
    scheme === 'bearer'
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }
      : { 'Content-Type': 'application/json', [typeof scheme === 'string' ? scheme : 'X-Api-Key']: cfg.apiKey };
  let authScheme: string = cfg.authHeader ?? 'bearer';

  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
    try {
      const res = await fetch(endpoint(cfg.baseUrl), {
        method: 'POST',
        headers: mkHeaders(authScheme),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (res.status === 401 && !cfg.authHeader && authScheme === 'bearer' && cfg.apiKey) {
        // gateway rejected Bearer - try the other common scheme once
        authScheme = 'X-Api-Key';
        lastError = 'renegotiating auth: Bearer rejected, retrying with X-Api-Key';
        attempt--;
        continue;
      }
      if (!res.ok) {
        throw new Error(`provider: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      if (streaming) {
        clearTimeout(timer);
        return await consumeStream(res, opts.onDelta!);
      }
      const data = (await res.json()) as any;
      const choice = data.choices?.[0];
      if (!choice) throw new Error('provider: response had no choices');
      return {
        message: {
          role: 'assistant',
          content: choice.message?.content ?? null,
          ...(choice.message?.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
        },
        usage: data.usage,
      };
    } catch (err) {
      lastError = String(err);
      if (!/abort|fetch failed|ECONN|timeout/i.test(lastError)) throw err;
      await sleep(1500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`provider: failed after retry (${cfg.baseUrl}): ${lastError}`);
}

/** Assemble a ChatResponse from an SSE stream, emitting deltas as they land. */
async function consumeStream(
  res: Response,
  onDelta: (kind: DeltaKind, chunk: string) => void,
): Promise<ChatResponse> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let reasoning = '';
  let usage: ChatResponse['usage'];
  // tool_calls accumulate across deltas, keyed by their index in the stream.
  const calls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
  // Idle guard rather than a total cap: generation length is unbounded.
  const idleCtrl = new AbortController();
  let idleTimer = setTimeout(() => idleCtrl.abort(), 180_000);
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idleCtrl.abort(), 180_000);
  };
  const idlePromise = new Promise<never>((_, reject) => {
    idleCtrl.signal.addEventListener('abort', () => reject(new Error('provider: stream idle timeout')), { once: true });
  });
  const pump = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), idlePromise]);
      if (done) return;
      bumpIdle();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue; // keep-alive comment or malformed line
        }
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onDelta('reasoning', delta.reasoning_content);
        } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
          reasoning += delta.reasoning;
          onDelta('reasoning', delta.reasoning);
        }
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          onDelta('text', delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = calls.get(idx) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.function.name += tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
            calls.set(idx, cur);
          }
        }
      }
    }
  };
  try {
    await pump();
  } finally {
    clearTimeout(idleTimer);
    reader.releaseLock();
  }
  const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  return {
    message: {
      role: 'assistant',
      content: text || null,
      ...(ordered.length > 0 ? { tool_calls: ordered } : {}),
    },
    usage,
  };
}

/** Accept bases both with and without the /v1 suffix. */
function endpoint(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return b.endsWith('/v1') ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

/**
 * Single multimodal call: text prompt + one image (data URL). Used by the
 * see_image tool; deliberately separate from chat() so the streaming path
 * stays boring. Non-streaming, one retry, hard timeout.
 */
export async function chatVision(
  cfg: ProviderConfig,
  prompt: string,
  imageDataUrl: string,
  opts: { timeoutMs?: number; maxTokens?: number } = {},
): Promise<string> {
  const body = {
    model: cfg.model,
    max_tokens: opts.maxTokens ?? 800,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
  };
  let lastError = '';
  // same auth negotiation as chat(): explicit header, Bearer, then X-Api-Key
  let vAuth: string = cfg.authHeader ?? 'bearer';
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
    try {
      const vHeaders = vAuth === 'bearer'
        ? { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }
        : { 'Content-Type': 'application/json', [vAuth]: cfg.apiKey };
      const res = await fetch(endpoint(cfg.baseUrl), {
        method: 'POST',
        headers: vHeaders,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 401 && !cfg.authHeader && vAuth === 'bearer' && cfg.apiKey) {
        vAuth = 'X-Api-Key';
        attempt--;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`provider: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as any;
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('provider: vision response had no content');
      return text;
    } catch (err) {
      lastError = String(err);
      if (!/abort|fetch failed|ECONN|timeout/i.test(lastError)) throw err;
      await sleep(1500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`provider: vision call failed after retry (${cfg.baseUrl}): ${lastError}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
