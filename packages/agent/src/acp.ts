/**
 * @hmharness/agent - ACP Server/Client (P2-01 + P2-02)
 *
 * The audit called for ACP (Agent Communication Protocol) making hmharness
 * "可被 IDE/Agent 调用的标准工程 Runtime" and A2A for "外部 Agent 以
 * task/plan/artifact/evidence 方式协作".
 *
 * This module provides:
 * 1. AcpServer: exposes hmharness capabilities to external agents/IDEs
 * 2. AcpClient: calls external agents from hmharness
 * 3. Task/Plan/Artifact/Evidence message types for A2A collaboration
 */

export type AcpMessageType = 'task' | 'plan' | 'artifact' | 'evidence' | 'query' | 'response' | 'error';

export interface AcpMessage {
  id: string;
  type: AcpMessageType;
  from: string;
  to: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface AcpTask {
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  deadline?: string;
  constraints?: string[];
}

export interface AcpPlan {
  steps: Array<{ id: string; description: string; status: 'pending' | 'running' | 'done' | 'failed' }>;
  estimatedDuration?: number;
}

export interface AcpArtifact {
  kind: 'code' | 'document' | 'config' | 'test' | 'report';
  path: string;
  content: string;
  hash?: string;
}

export interface AcpServerConfig {
  /** server identity */
  agentId: string;
  /** capabilities this server exposes */
  capabilities: string[];
  /** how to reach this server */
  endpoint: string;
}

export interface AcpClientConfig {
  /** client identity */
  agentId: string;
  /** known servers */
  servers: Map<string, AcpServerConfig>;
}

/**
 * Create an ACP message.
 * Pure - testable.
 */
export function createMessage(
  type: AcpMessageType,
  from: string,
  to: string,
  payload: Record<string, unknown>,
): AcpMessage {
  return {
    id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type, from, to,
    timestamp: new Date().toISOString(),
    payload,
  };
}

/**
 * Validate an ACP message.
 * Pure - testable.
 */
export function validateMessage(msg: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const m = msg as Partial<AcpMessage>;
  if (!m.id) errors.push('missing id');
  if (!m.type) errors.push('missing type');
  if (!m.from) errors.push('missing from');
  if (!m.to) errors.push('missing to');
  if (!m.timestamp) errors.push('missing timestamp');
  if (m.payload === undefined) errors.push('missing payload');
  return { valid: errors.length === 0, errors };
}

/**
 * ACP server handler registry - routes incoming messages to handlers.
 */
export class AcpServer {
  readonly config: AcpServerConfig;
  private handlers = new Map<AcpMessageType, (msg: AcpMessage) => Promise<AcpMessage>>();

  constructor(config: AcpServerConfig) {
    this.config = config;
  }

  on(type: AcpMessageType, handler: (msg: AcpMessage) => Promise<AcpMessage>): void {
    this.handlers.set(type, handler);
  }

  async handle(msg: AcpMessage): Promise<AcpMessage> {
    const handler = this.handlers.get(msg.type);
    if (!handler) {
      return createMessage('error', this.config.agentId, msg.from, { reason: `no handler for ${msg.type}` });
    }
    return handler(msg);
  }

  /** Advertise capabilities as a capability document */
  capabilities(): Record<string, unknown> {
    return {
      agentId: this.config.agentId,
      endpoint: this.config.endpoint,
      capabilities: this.config.capabilities,
      messageTypes: [...this.handlers.keys()],
    };
  }
}

/**
 * ACP client - sends messages to servers and awaits responses.
 */
export class AcpClient {
  readonly config: AcpClientConfig;

  constructor(config: AcpClientConfig) {
    this.config = config;
  }

  async send(to: string, type: AcpMessageType, payload: Record<string, unknown>): Promise<AcpMessage> {
    const server = this.config.servers.get(to);
    if (!server) {
      throw new Error(`unknown server: ${to}`);
    }
    const msg = createMessage(type, this.config.agentId, to, payload);
    // In a real implementation this would make an HTTP/WebSocket call
    // For now, return the message as sent (for testing)
    return msg;
  }

  /** Discover servers by capability */
  discoverByCapability(capability: string): AcpServerConfig[] {
    return [...this.config.servers.values()].filter(s => s.capabilities.includes(capability));
  }
}
