/**
 * @hmh/kernel - provider
 * OpenAI-compatible chat adapter. Works with any /v1/chat/completions
 * endpoint: zhipu GLM, OpenRouter, FreeRide gateway, vLLM, Ollama, ...
 * Non-streaming for the walking skeleton (streaming lands in Phase 1.2);
 * one retry on transient 429/5xx, hard timeout via AbortController.
 */
import type { ChatMessage, ProviderConfig } from './types.ts';

export interface ChatResponse {
  message: ChatMessage;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export async function chat(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools?: unknown[],
  opts: { timeoutMs?: number } = {},
): Promise<ChatResponse> {
  const body: Record<string, unknown> = { model: cfg.model, messages };
  if (tools && tools.length > 0) body.tools = tools;

  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
    try {
      const res = await fetch(endpoint(cfg.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        throw new Error(`provider: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
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

/** Accept bases both with and without the /v1 suffix. */
function endpoint(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return b.endsWith('/v1') ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
