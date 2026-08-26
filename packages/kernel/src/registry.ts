/**
 * @hmh/kernel - registry
 * The capability registry. One Map, duplicate-name rejection, OpenAI shape
 * projection. Boring on purpose: 2026 consensus is that the loop+registry
 * core should stay simple while capability volume grows around it.
 */
import type { Tool } from './types.ts';

export class Registry {
  #tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`kernel/registry: duplicate tool name "${tool.name}"`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: Tool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  names(): string[] {
    return [...this.#tools.keys()];
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  /** Project into the OpenAI chat.completions `tools` array. */
  toOpenAITools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
    return this.list().map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
}
