/**
 * @hmharness/lsp - protocol (LSP 3.18 subset + JSON-RPC framing)
 *
 * Client-side types ONLY (master prompt: we implement the Client/Manager,
 * never a language server). The subset below covers the Tier-0/Tier-1
 * agent surface: lifecycle, diagnostics, hover, definition, references,
 * document symbols, plus the framing primitives every message rides on.
 */

/* ---------------- JSON-RPC / framing ---------------- */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** `Content-Length: N\r\n\r\n<payload>` framing (LSP base protocol). */
export function encodeMessage(obj: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'), payload]);
}

/** Incremental frame decoder: feed stdout chunks, get parsed messages. */
export class MessageDecoder {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = this.buf.subarray(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.subarray(headerEnd + 4); continue; }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) break; // partial body
      const body = this.buf.subarray(bodyStart, bodyStart + len).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + len);
      try { out.push(JSON.parse(body)); } catch { /* skip malformed frame */ }
    }
    return out;
  }
}

/* ---------------- lifecycle ---------------- */

export interface InitializeParams {
  processId: number | null;
  rootUri: string | null;
  workspaceFolders: Array<{ name: string; uri: string }> | null;
  capabilities: Record<string, unknown>;
}
export interface InitializeResult {
  capabilities: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
}

/* ---------------- positions / documents ---------------- */

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface Location { uri: string; range: Range }
export interface TextDocumentIdentifier { uri: string }
export interface VersionedTextDocumentIdentifier { uri: string; version: number }

export interface DidOpenParams {
  textDocument: { uri: string; languageId: string; version: number; text: string };
}
export interface DidChangeParams {
  textDocument: VersionedTextDocumentIdentifier;
  contentChanges: Array<{ range?: Range; text: string }>;
}

/* ---------------- Tier-0 results ---------------- */

export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4; // Error | Warning | Information | Hint
  code?: number | string;
  source?: string;
  message: string;
}
export interface PublishDiagnosticsParams { uri: string; diagnostics: Diagnostic[] }

export interface Hover { contents: unknown; range?: Range }
export interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange?: Range;
  children?: DocumentSymbol[];
}
export interface ReferenceParams {
  textDocument: TextDocumentIdentifier;
  position: Position;
  context: { includeDeclaration: boolean };
}

export const LSP_TIMEOUT_DEFAULT_MS = 20_000;
