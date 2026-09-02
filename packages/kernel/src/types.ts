/**
 * @hmh/kernel - types
 * The kernel contract surface. Deliberately small: a Tool, a chat message,
 * a provider config. Everything else in hmharness composes from these.
 */

/** A JSON-Schema-shaped parameter description (OpenAI tool-call format). */
export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** Uniform tool execution result. */
export interface ToolResult {
  output: string;
  isError?: boolean;
}

/** Per-invocation context handed to every tool. */
export interface ToolContext {
  /** Working directory for filesystem/shell tools. */
  cwd: string;
  /** hmharness home (isolated state root, e.g. ~/.hmharness). */
  home: string;
}

/** A capability the agent may call. The entire extension surface. */
export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /**
   * Declarative risk marker: when this returns true the loop must obtain
   * user approval before executing (see LoopOptions.approval). Absent or
   * false means read-only / safe. Remote (MCP) tools default to needing
   * approval unless their server is marked trusted.
   */
  needsApproval?(args: Record<string, unknown>): boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** OpenAI-style chat message, reused across provider adapters. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/** Connection settings for an OpenAI-compatible endpoint. */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** User-level configuration (HMH_HOME/config.json). */
export interface HmhConfig {
  provider: ProviderConfig;
  maxTurns: number;
  /** 'ask' (default) prompts before risky tools; 'auto' approves everything. */
  approval?: 'ask' | 'auto';
  /** Rough context budget in chars before old tool outputs get pruned. */
  maxContextChars?: number;
  /** MCP servers whose tools are projected into the registry at startup. */
  mcpServers?: Record<string, McpServerImport>;
  /** Vision-capable provider for see_image (any OpenAI-compatible endpoint). */
  vision?: ProviderConfig;
  /** Tried in order after `vision` fails (multi-provider resilience). */
  visionFallbacks?: ProviderConfig[];
  /** UI + system-prompt language. Default 'zh'. */
  locale?: 'zh' | 'en';
  /** Named vendor endpoints for multi-provider routing. */
  providers?: Record<string, ProviderConfig>;
  /** Per-purpose provider names resolved against `providers`. */
  routing?: {
    /** main chat loop (default: `provider`) */
    chat?: string;
    /** see_image (default: `vision`) */
    vision?: string;
    /** evolution meta-calls (default: chat) */
    evolve?: string;
    /** bench runner (default: chat) */
    bench?: string;
  };
}

/** Resolve a purpose to a concrete provider config (routing > legacy fields). */
export function resolveProvider(cfg: HmhConfig, purpose: 'chat' | 'vision' | 'evolve' | 'bench'): ProviderConfig {
  const named = cfg.routing?.[purpose] ?? (purpose === 'vision' ? undefined : cfg.routing?.chat);
  if (named && cfg.providers?.[named]) return cfg.providers[named];
  if (purpose === 'vision') return cfg.vision ?? cfg.provider;
  return cfg.provider;
}

/** One row of `/model` listings: a named provider and what it currently serves. */
export interface ProviderView {
  name: string;
  model: string;
  baseUrl: string;
  /** purposes this provider resolves for right now (chat/vision/evolve/bench) */
  purposes: string[];
}

export function listProviders(cfg: HmhConfig): ProviderView[] {
  const purposesOf = (n: string): string[] => {
    const out: string[] = [];
    for (const p of ['chat', 'vision', 'evolve', 'bench'] as const) {
      const named = cfg.routing?.[p] ?? (p !== 'vision' ? cfg.routing?.chat : undefined);
      if (named === n) out.push(p);
    }
    return out;
  };
  if (cfg.providers && Object.keys(cfg.providers).length) {
    return Object.entries(cfg.providers).map(([name, p]) => ({ name, model: p.model, baseUrl: p.baseUrl, purposes: purposesOf(name) }));
  }
  return [{ name: 'default', model: cfg.provider.model, baseUrl: cfg.provider.baseUrl, purposes: ['chat', 'vision', 'evolve', 'bench'] }];
}

/** Built-in OpenAI-compatible presets (source of truth for docs/PROVIDERS.md). */
export interface ProviderPreset {
  name: string;
  baseUrl: string;
  envVar: string;
  model: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', envVar: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
  { name: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', envVar: 'MOONSHOT_API_KEY', model: 'kimi-latest' },
  { name: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', envVar: 'ZHIPU_API_KEY', model: 'glm-4.7' },
  { name: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', envVar: 'DASHSCOPE_API_KEY', model: 'qwen3-max' },
  { name: 'openai', baseUrl: 'https://api.openai.com/v1', envVar: 'OPENAI_API_KEY', model: 'gpt-5' },
  { name: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', envVar: 'SILICONFLOW_API_KEY', model: 'deepseek-ai/DeepSeek-V3.2-Exp' },
  { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', envVar: 'OPENROUTER_API_KEY', model: 'openrouter/auto' },
  { name: 'nvidia-nim', baseUrl: 'https://integrate.api.nvidia.com/v1', envVar: 'NVIDIA_API_KEY', model: 'meta/llama-3.2-90b-vision-instruct' },
  { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', envVar: 'GROQ_API_KEY', model: 'llama-3.3-70b-versatile' },
  { name: 'together', baseUrl: 'https://api.together.xyz/v1', envVar: 'TOGETHER_API_KEY', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { name: 'xai', baseUrl: 'https://api.x.ai/v1', envVar: 'XAI_API_KEY', model: 'grok-4' },
  { name: 'minimax', baseUrl: 'https://api.minimaxi.com/v1', envVar: 'MINIMAX_API_KEY', model: 'MiniMax-M2' },
  { name: 'volc-ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', envVar: 'ARK_API_KEY', model: 'doubao-seed-1-6' },
  { name: 'stepfun', baseUrl: 'https://api.stepfun.com/v1', envVar: 'STEPFUN_API_KEY', model: 'step-3' },
  { name: 'hunyuan', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', envVar: 'HUNYUAN_API_KEY', model: 'hunyuan-turbos-latest' },
  { name: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', envVar: '', model: 'qwen3:8b' },
  { name: 'lm-studio', baseUrl: 'http://127.0.0.1:1234/v1', envVar: '', model: 'local-model' },
];

/**
 * Detect locally available providers, dsh-style: presets whose env var is
 * set, plus anything configured in ~/.opencode (opencode.json providers).
 * Already-configured names are excluded. Read-only - callers decide whether
 * to merge into config via addProviders().
 */
export async function detectLocalProviders(cfg: HmhConfig, readFileFn: typeof import('node:fs/promises')['readFile']): Promise<ProviderPreset[]> {
  const known = new Set(Object.keys(cfg.providers ?? {}));
  const found: ProviderPreset[] = [];
  for (const p of PROVIDER_PRESETS) {
    if (known.has(p.name)) continue;
    // cloud presets: available when their env var is set; local-inference
    // presets are intentionally NOT auto-added (caller opts in by hand)
    if (p.envVar && process.env[p.envVar]) found.push(p);
  }
  // local OpenAI-compatible gateways: an env key plus a live /v1/models on a
  // common loopback port (e.g. freellmapi on 3002, ollama on 11434)
  for (const [envVar, ports] of [
    ['FREELLM_API_KEY', [3002, 8080]],
    ['OPENAI_COMPAT_API_KEY', [8080, 3000]],
  ] as const) {
    if (!process.env[envVar] || found.some((x) => x.name === envVar.toLowerCase().replace('_api_key', ''))) continue;
    for (const port of ports) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
          headers: { Authorization: `Bearer ${process.env[envVar]}` },
          signal: AbortSignal.timeout(800),
        });
        if (!r.ok) continue;
        const d = (await r.json()) as { data?: Array<{ id?: string }> };
        const model = d.data?.[0]?.id ?? 'auto';
        found.push({ name: envVar.toLowerCase().replace('_api_key', ''), baseUrl: `http://127.0.0.1:${port}/v1`, envVar: `(local gateway, key from ${envVar})`, model });
        break;
      } catch {
        /* port closed - try next */
      }
    }
  }
  // opencode config carries provider ids + baseURLs + models
  try {
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    for (const f of [join(homedir(), '.opencode', 'opencode.json'), join(process.cwd(), '.opencode.json')]) {
      let raw: string;
      try { raw = await readFileFn(f, 'utf8'); } catch { continue; }
      const oc = JSON.parse(raw) as { provider?: Record<string, { npm?: string; models?: Record<string, unknown>; options?: { baseURL?: string } }> };
      for (const [id, def] of Object.entries(oc.provider ?? {})) {
        if (known.has(id) || found.some((x) => x.name === id)) continue;
        const baseURL = def.options?.baseURL ?? '';
        const firstModel = Object.keys(def.models ?? {})[0] ?? '';
        if (baseURL && firstModel) {
          found.push({ name: id, baseUrl: baseURL, envVar: `(opencode: ${f.includes('.opencode.json') && !f.includes(homedir()) ? 'project' : 'user'})`, model: firstModel });
        }
      }
    }
  } catch {
    /* unreadable opencode config is fine */
  }
  return found;
}

/** Shape used in config.json (kernel/src/mcp.ts has the runtime client). */
export interface McpServerImport {
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Skip the per-call approval prompt for this server's tools. */
  trusted?: boolean;
}
