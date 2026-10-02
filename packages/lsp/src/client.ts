/**
 * @hmharness/lsp - LSP client over stdio
 *
 * Speaks the base protocol to ONE managed language-server process:
 * initialize handshake -> requests (hover/definition/references/symbols)
 * -> document sync notifications -> shutdown/exit. Diagnostics arrive as
 * push notifications and land in the caller's callback (diagnostics-store
 * behavior is the caller's; here we just route).
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  encodeMessage, MessageDecoder,
  type InitializeParams, type InitializeResult, type JsonRpcResponse,
  type Diagnostic, type DidOpenParams, type Hover, type Location, type DocumentSymbol, type ReferenceParams, type Position, type TextDocumentIdentifier,
} from './protocol.ts';

export interface LspClientOptions {
  requestTimeoutMs?: number;
  onDiagnostics?: (uri: string, diagnostics: Diagnostic[]) => void;
}

export class LspClient {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private decoder = new MessageDecoder();
  private serverInfo: InitializeResult | null = null;

  constructor(private proc: ChildProcessWithoutNullStreams, private opts: LspClientOptions = {}) {
    proc.stdout.on('data', (chunk: Buffer) => {
      for (const msg of this.decoder.push(chunk)) this.handle(msg as Record<string, unknown>);
    });
    proc.on('exit', () => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('server exited')); }
      this.pending.clear();
    });
  }

  private handle(msg: Record<string, unknown>): void {
    if (msg.method === 'textDocument/publishDiagnostics') {
      const p = msg.params as { uri: string; diagnostics: Diagnostic[] };
      this.opts.onDiagnostics?.(p.uri, p.diagnostics ?? []);
      return;
    }
    if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      const resp = msg as unknown as JsonRpcResponse;
      if (resp.error) p.reject(new Error(`LSP ${resp.error.code}: ${resp.error.message}`));
      else p.resolve(resp.result);
    }
    // window/logMessage etc: intentionally ignored (noise for the agent)
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out`));
      }, this.opts.requestTimeoutMs ?? 20_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin.write(encodeMessage({ jsonrpc: '2.0', method, params }));
  }

  async initialize(rootUri: string): Promise<InitializeResult> {
    const params: InitializeParams = {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ name: 'workspace', uri: rootUri }],
      capabilities: { textDocument: { hover: {}, definition: {}, references: {}, documentSymbol: {}, publishDiagnostics: {} } },
    };
    const result = await this.request<InitializeResult>('initialize', params);
    this.serverInfo = result;
    this.notify('initialized', {});
    return result;
  }

  get info(): InitializeResult | null {
    return this.serverInfo;
  }

  /* ---------------- document sync (minimal: open + full change) ---------------- */

  openDoc(uri: string, languageId: string, text: string): void {
    const params: DidOpenParams = { textDocument: { uri, languageId, version: 1, text } };
    this.notify('textDocument/didOpen', params);
  }

  /* ---------------- Tier-0 requests ---------------- */

  hover(textDocument: TextDocumentIdentifier, position: Position): Promise<Hover | null> {
    return this.request<Hover | null>('textDocument/hover', { textDocument, position });
  }

  definition(textDocument: TextDocumentIdentifier, position: Position): Promise<Location | Location[] | null> {
    return this.request<Location | Location[] | null>('textDocument/definition', { textDocument, position });
  }

  references(textDocument: TextDocumentIdentifier, position: Position, includeDeclaration = false): Promise<Location[]> {
    const params: ReferenceParams = { textDocument, position, context: { includeDeclaration } };
    return this.request<Location[]>('textDocument/references', params);
  }

  documentSymbols(textDocument: TextDocumentIdentifier): Promise<DocumentSymbol[]> {
    return this.request<DocumentSymbol[]>('textDocument/documentSymbol', { textDocument });
  }

  async shutdown(): Promise<void> {
    try { await this.request('shutdown'); this.notify('exit'); } catch { /* best effort */ }
  }
}
