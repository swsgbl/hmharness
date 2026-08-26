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
