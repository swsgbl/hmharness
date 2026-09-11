/**
 * @hmharness/kernel - types
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
  /** Custom auth header name for gateways that reject Bearer (e.g. 'X-Api-Key'
   *  for freellmapi). Omit for standard Authorization: Bearer; on 401 the
   *  provider renegotiates with X-Api-Key automatically. */
  authHeader?: string;
  /** Per-request timeout override (ms). Slow reasoning models (free-tier
   *  tokenrouter took 84s on an evolve-sized prompt vs the 120s default)
   *  set e.g. 240000 on the evolve/bench routes. */
  timeoutMs?: number;
  /** Explicit context window (tokens) for this model. Overrides the
   *  built-in registry; the transcript budget then scales to the window
   *  (see window.ts) instead of the fixed legacy default. */
  contextWindow?: number;
  /** Capability marker: can this model accept image input?
   *  Set `false` on a text-only model that is (or might be) named by
   *  `routing.vision`. resolveProvider('vision') then SKIPS it instead of
   *  silently posting screenshots to a blind model - which answers HTTP 200
   *  with "I can't view the image" and used to be graded as "the expected
   *  UI text is not on screen" (a FALSE-NEGATIVE regression FAIL).
   *  Omitted = unknown, and the provider is used as before. */
  supportsVision?: boolean;
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
  /** SSH hosts the agent may operate (name -> {host,user,port,keyPath}).
   *  Secrets stay in HMH_HOME; the ssh_run tool reads them from here. */
  sshHosts?: Record<string, { host: string; user: string; port?: number; keyPath?: string }>;
  /** Vision-capable provider for see_image (any OpenAI-compatible endpoint). */
  vision?: ProviderConfig;
  /** Tried in order after `vision` fails (multi-provider resilience). */
  visionFallbacks?: ProviderConfig[];
  /** UI + system-prompt language. Default 'zh'. */
  locale?: 'zh' | 'en';
  /** Run a background evolution cycle after every N recorded insights
   *  (default 3; 0 disables). Tier 3 of the feedback ladder: Tier 1 = raw
   *  error self-notes (every task, zero cost), Tier 2 = one model-call
   *  lesson per erroring task (instant reflection), Tier 3 = this - full
   *  cycle with bench gate. Guards unchanged: double-gate, holdout, poison
   *  screen, writes only under skills/ and memory/. */
  autoEvolveEvery?: number;
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

/** Resolve a purpose to a concrete provider config (routing > legacy fields).
 *
 * For 'vision' a provider explicitly marked `supportsVision: false` is NOT
 * accepted: it is skipped so the dedicated `vision` block (or the chat
 * default) wins instead. Rationale - `routing.vision` used to shadow the
 * `vision` block unconditionally, so a text-only model there received every
 * screenshot and replied "I can't view the image" with HTTP 200; the UI
 * regression tool then reported a FAIL about the app instead of a provider
 * failure (false negative, mis-attributed to the product). */
export function resolveProvider(cfg: HmhConfig, purpose: 'chat' | 'vision' | 'evolve' | 'bench'): ProviderConfig {
  if (purpose === 'vision') {
    const chain = visionProviderChain(cfg);
    if (chain.length > 0) return chain[0];
    return cfg.vision ?? cfg.provider;
  }
  const named = cfg.routing?.[purpose] ?? cfg.routing?.chat;
  if (named && cfg.providers?.[named]) return cfg.providers[named];
  return cfg.provider;
}

/**
 * Ordered vision candidates: routing.vision provider, the legacy `vision`
 * block, then `visionFallbacks`; de-duplicated by endpoint+model and with
 * providers marked `supportsVision: false` removed. If everything is marked
 * blind the unfiltered list is returned, so callers still get today's
 * (failing, but informative) behaviour instead of "no vision provider".
 * A caller looping this chain turns a blind/dead provider into a retry
 * rather than a wrong answer.
 */
export function visionProviderChain(cfg: HmhConfig): ProviderConfig[] {
  const routed = cfg.routing?.vision ? cfg.providers?.[cfg.routing.vision] : undefined;
  const all = [routed, cfg.vision, ...(cfg.visionFallbacks ?? []), cfg.provider].filter(
    (p): p is ProviderConfig => Boolean(p && p.baseUrl),
  );
  const seen = new Set<string>();
  const unique = all.filter((p) => {
    const k = `${p.baseUrl}|${p.model}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const sighted = unique.filter((p) => p.supportsVision !== false);
  return sighted.length > 0 ? sighted : unique;
}

/**
 * Did the model answer "I can't see any image" instead of describing one?
 * A blind (text-only) provider returns HTTP 200 with prose like this, so
 * callers MUST NOT treat such a reply as evidence about the image - for UI
 * regression that is the difference between a provider failure and a
 * product FAIL. Checked on the head of the answer, where refusals live.
 */
export function isVisionRefusal(text: string): boolean {
  const head = (text ?? '').trim().slice(0, 600);
  if (!head) return false;
  return VISION_REFUSAL_PATTERNS.some((re) => re.test(head));
}

/** Head-of-answer phrases that mean "I never looked at the image". Kept as
 *  small separate patterns so each one is verifiable on its own. */
export const VISION_REFUSAL_PATTERNS: RegExp[] = [
  /i\s*(?:'|\u2019)?(?:m|am)\s*(?:not\s+able|unable)\s+to\s+(?:view|see|access|read|analy[sz]e)/i,
  /i\s+can(?:'|\u2019)?t\s+(?:view|see|access|read|analy[sz]e)\s+(?:the|this|that|any|an)?\s*(?:\w+\s+)?(?:image|images|picture|photo|screenshot)/i,
  /\bcannot\s+(?:view|see|access|read)\s+(?:the|this|that|any)?\s*(?:\w+\s+)?(?:image|images|picture|photo|screenshot)/i,
  /unable\s+to\s+(?:view|see|process|access|analy[sz]e)\s+(?:the|this|any)?\s*(?:\w+\s+)?(?:image|images|picture|photo|screenshot)/i,
  /no\s+image\s+(?:was\s+|is\s+)?(?:provided|attached|received|supplied|included)/i,
  /i\s+don(?:'|\u2019)?t\s+see\s+(?:an|any)\s+image/i,
  /i\s+(?:do\s+not|don(?:'|\u2019)?t)\s+have\s+(?:the\s+)?(?:ability|capability)\s+to\s+(?:view|see|process)\s+(?:image|images|the\s+image)/i,
  /as\s+an?\s+(?:ai|artificial\s+intelligence|language\s+model|text[- ]only\s+model)[^.\n]{0,60}(?:can(?:'|\u2019)?t|cannot|unable|do\s+not)/i,
  /\bi\s+can(?:'|\u2019)?t\s+\w+\s+(?:the|this)\s+(?:image|screenshot|picture|photo)/i,
  /\u6211\s*(?:\u65e0\u6cd5|\u4e0d\u80fd|\u6ca1\u6cd5|\u770b\u4e0d\u5230)\s*(?:\u67e5\u770b|\u770b\u5230|\u8bc6\u522b|\u8bfb\u53d6|\u7406\u89e3|\u770b\u89c1)?[^\u3002\n]{0,12}(?:\u56fe\u7247|\u56fe\u50cf)/,
  /(?:\u65e0\u6cd5|\u4e0d\u80fd)\s*(?:\u67e5\u770b|\u8bc6\u522b|\u8bfb\u53d6)\s*(?:\u56fe\u7247|\u56fe\u50cf)/,
  /\u4f5c\u4e3a\s*(?:\u4e00\u4e2a)?\s*(?:AI|\u4eba\u5de5\u667a\u80fd|\u8bed\u8a00\u6a21\u578b|\u6587\u672c\u6a21\u578b)[^\u3002\n]{0,30}(?:\u65e0\u6cd5|\u4e0d\u80fd)/,
  /(?:\u672a|\u6ca1\u6709)(?:\u6536\u5230|\u770b\u5230|\u68c0\u6d4b\u5230)\s*(?:\u4efb\u4f55)?\s*\u56fe\u7247/,
  // observed live 2026-09-11 from the local text-only @quality endpoint:
  // "The device screen cannot be described because the provided image is
  //  unsupported or unavailable. FOUND: No readable UI text" - it parroted
  // the required FOUND: line while admitting it never received the image.
  /(?:image|screenshot|picture|photo)\s+(?:is\s+|was\s+|appears\s+)?(?:unsupported|unavailable|not\s+supported|invalid|unreadable|missing)/i,
  /(?:unsupported|unavailable|invalid|unreadable)\s+(?:image|screenshot|picture|photo|image\s+format|attachment)/i,
  /(?:cannot|can(?:'|\u2019)?t|unable\s+to)\s+be\s+described/i,
  /(?:unable|not\s+able)\s+to\s+describe\s+(?:the|this|any)?\s*(?:image|screenshot|screen|picture|photo)/i,
];

/** The `FOUND: <text>` line the regression prompt demands, or null. */
export function foundLineText(described: string): string | null {
  const m = /found:\s*(.+)/i.exec(described ?? '');
  return m ? m[1].trim().replace(/[.。]+$/, '') : null;
}

/**
 * Did the model itself report reading NO text? Then there is no evidence
 * about the app either way - the screen may be blank, or the provider may be
 * blind. Either way this is "no verdict", NOT a product FAIL (confirm from
 * the device view tree instead).
 */
export function foundNothing(described: string): boolean {
  const fnd = foundLineText(described);
  if (fnd === null) return false;
  return /^(?:no|none|n\/?a|nil|nothing|null|-{1,3})[\s\S]{0,40}$/i.test(fnd) || /no\s+readable\s+(?:ui\s+)?text/i.test(fnd);
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
      if (named !== n) continue;
      // a provider marked text-only does not serve vision, whatever routing says
      if (p === 'vision' && cfg.providers?.[n]?.supportsVision === false) continue;
      out.push(p);
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
  /** auth header the gateway requires (freellmapi: X-Api-Key) */
  authHeader?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', envVar: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
  { name: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', envVar: 'MOONSHOT_API_KEY', model: 'kimi-latest' },
  { name: 'glm', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', envVar: 'ZHIPU_API_KEY', model: 'glm-5.3' },
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
  // common loopback port (e.g. freellmapi on 3002, ollama on 11434); the
  // probe negotiates auth (Bearer, then X-Api-Key) and remembers the scheme
  for (const [envVar, ports] of [
    ['FREELLM_API_KEY', [3002, 8080]],
    ['OPENAI_COMPAT_API_KEY', [8080, 3000]],
  ] as const) {
    if (!process.env[envVar] || found.some((x) => x.name === envVar.toLowerCase().replace('_api_key', ''))) continue;
    for (const port of ports) {
      try {
        const key = process.env[envVar];
        let r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(800),
        });
        let authHeader: string | undefined;
        if (r.status === 401) {
          r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
            headers: { 'X-Api-Key': key },
            signal: AbortSignal.timeout(800),
          });
          if (r.ok) authHeader = 'X-Api-Key';
        }
        if (!r.ok) continue;
        const d = (await r.json()) as { data?: Array<{ id?: string }> };
        const model = d.data?.[0]?.id ?? 'auto';
        found.push({ name: envVar.toLowerCase().replace('_api_key', ''), baseUrl: `http://127.0.0.1:${port}/v1`, envVar: `(local gateway, key from ${envVar})`, model, ...(authHeader ? { authHeader } : {}) });
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
