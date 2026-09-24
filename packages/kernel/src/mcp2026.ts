/**
 * @hmharness/kernel - MCP 2026-07-28 Conformance (P0-03)
 *
 * Updates the MCP client to conform to the 2026-07-28 specification:
 * 1. Stateless core: operations don't require session state
 * 2. Header-based routing: Mcp-Session-Id, Mcp-Protocol-Version headers
 * 3. Tasks extension: long-running task lifecycle management
 * 4. Authorization hardening: per-request auth validation
 * 5. Cacheable list results: ETag/If-None-Match for tools/resources lists
 *
 * Reference: https://modelcontextprotocol.io/specification/2025-11-25
 * (2026-07-28 is the latest ratification with these additions)
 */

/** MCP protocol version we conform to */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

/** Headers defined by the 2026-07-28 spec */
export const MCP_HEADERS = {
  sessionId: 'Mcp-Session-Id',
  protocolVersion: 'Mcp-Protocol-Version',
  lastEventId: 'Last-Event-Id',
} as const;

/** Task lifecycle states (Tasks extension) */
export type McpTaskStatus = 'submitted' | 'working' | 'input-required' | 'completed' | 'cancelled' | 'failed';

export interface McpTask {
  id: string;
  status: McpTaskStatus;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * Build headers for an MCP request per the 2026-07-28 spec.
 * Pure - testable.
 */
export function buildMcpHeaders(opts: {
  sessionId?: string;
  protocolVersion?: string;
  lastEventId?: string;
  authorization?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [MCP_HEADERS.protocolVersion]: opts.protocolVersion ?? MCP_PROTOCOL_VERSION,
  };
  if (opts.sessionId) headers[MCP_HEADERS.sessionId] = opts.sessionId;
  if (opts.lastEventId) headers[MCP_HEADERS.lastEventId] = opts.lastEventId;
  if (opts.authorization) headers['Authorization'] = opts.authorization;
  return headers;
}

/**
 * Validate MCP response headers for protocol compliance.
 * Pure - testable.
 */
export function validateMcpResponseHeaders(headers: Record<string, string>): {
  valid: boolean;
  issues: string[];
  sessionId?: string;
} {
  const issues: string[] = [];
  const version = headers[MCP_HEADERS.protocolVersion];
  if (!version) issues.push(`missing ${MCP_HEADERS.protocolVersion} header`);
  else if (!version.startsWith('2026-')) issues.push(`unsupported protocol version: ${version}`);
  const sid = headers[MCP_HEADERS.sessionId];
  if (sid) return { valid: issues.length === 0, issues, sessionId: sid };
  return { valid: issues.length === 0, issues };
}

/**
 * Determine if a tools/resources list response can be cached.
 * The 2026-07-28 spec makes list results cacheable via ETag.
 * Pure - testable.
 */
export function isCacheableListResponse(headers: Record<string, string>): {
  cacheable: boolean;
  etag?: string;
} {
  const etag = headers['ETag'] || headers['etag'];
  return { cacheable: Boolean(etag), etag };
}

/**
 * Build a conditional list request using a cached ETag.
 * Pure - testable.
 */
export function buildConditionalListRequest(cachedEtag?: string): Record<string, string> {
  if (!cachedEtag) return {};
  return { 'If-None-Match': cachedEtag };
}

/**
 * Check if an HTTP 304 response means the cached list is still valid.
 * Pure - testable.
 */
export function isNotModified(status: number): boolean {
  return status === 304;
}

/**
 * Task state machine per the Tasks extension.
 * Pure - testable.
 */
export function canTransitionTask(from: McpTaskStatus, to: McpTaskStatus): boolean {
  const transitions: Record<McpTaskStatus, McpTaskStatus[]> = {
    'submitted': ['working', 'cancelled', 'failed'],
    'working': ['input-required', 'completed', 'cancelled', 'failed'],
    'input-required': ['working', 'cancelled', 'failed'],
    'completed': [],  // terminal
    'cancelled': [],  // terminal
    'failed': [],     // terminal
  };
  return transitions[from]?.includes(to) ?? false;
}

/**
 * Authorization check per the 2026-07-28 hardening requirements.
 * Pure - testable.
 */
export function validateMcpAuth(config: {
  type: 'stdio' | 'http';
  headers?: Record<string, string>;
}): { authorized: boolean; reason: string } {
  if (config.type === 'stdio') {
    // stdio doesn't need HTTP auth (local process boundary)
    return { authorized: true, reason: 'stdio transport (local trust)' };
  }
  // HTTP transport requires Authorization header
  const auth = config.headers?.['Authorization'];
  if (!auth) return { authorized: false, reason: 'HTTP transport requires Authorization header' };
  if (!auth.startsWith('Bearer ') && !auth.startsWith('Basic ')) {
    return { authorized: false, reason: 'Authorization must be Bearer or Basic scheme' };
  }
  return { authorized: true, reason: 'valid authorization scheme' };
}
