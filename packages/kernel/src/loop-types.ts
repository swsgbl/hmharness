/**
 * @hmh/kernel - loop-types
 * Structural typing for the registry the loop needs (avoids a hard import
 * cycle and lets tests pass a stub registry).
 */
import type { Tool } from './types.ts';

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

export interface RegistryLike {
  get(name: string): Tool | undefined;
  toOpenAITools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>;
}
