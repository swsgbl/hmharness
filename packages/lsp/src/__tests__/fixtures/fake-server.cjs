/**
 * Fake LSP server for hermetic tests (no real language server needed on
 * CI): speaks the base protocol over stdio and answers the Tier-0
 * requests with fixed, deterministic results. Written as plain JS so the
 * test can spawn it directly with the system node.
 */
const fs = require('fs');

function send(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'), payload]));
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString('ascii'));
    if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
    const len = Number(m[1]);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + len) break;
    let msg;
    try { msg = JSON.parse(buf.subarray(bodyStart, bodyStart + len).toString('utf8')); } catch { buf = buf.subarray(bodyStart + len); continue; }
    buf = buf.subarray(bodyStart + len);
    handle(msg);
  }
});

function handle(msg) {
  if (msg.method === 'initialize' && typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true }, serverInfo: { name: 'fake-lsp', version: '0.0.1' } } });
    return;
  }
  if (msg.method === 'initialized') return;
  if (msg.method === 'shutdown' && typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  if (msg.method === 'exit') { process.exit(0); }
  if (msg.method === 'textDocument/didOpen') {
    const doc = msg.params.textDocument;
    if (doc.text.includes('DELBERATE_ERROR_MARKER')) {
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, source: 'fake-lsp', message: 'marker found: deliberate error' }] } });
    } else {
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, diagnostics: [] } });
    }
    return;
  }
  if (msg.method === 'textDocument/hover' && typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'plaintext', value: 'fake hover: symbol at ' + msg.params.position.line + ':' + msg.params.position.character } } });
    return;
  }
  if (msg.method === 'textDocument/definition' && typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, result: { uri: 'file:///fake/def.ts', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } } } });
    return;
  }
  if (msg.method === 'textDocument/references' && typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: 'file:///fake/r1.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } }, { uri: 'file:///fake/r2.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } } }] });
    return;
  }
  if (msg.method === 'textDocument/implementation' && typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: 'file:///fake/impl-a.ts', range: { start: { line: 9, character: 0 }, end: { line: 9, character: 6 } } }, { uri: 'file:///fake/impl-b.ts', range: { start: { line: 4, character: 0 }, end: { line: 4, character: 6 } } }] });
    return;
  }
  if (msg.method === 'textDocument/prepareCallHierarchy' && typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, result: [{ name: 'targetFn', kind: 12, uri: 'file:///fake/probe.ts', range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } } }] });
    return;
  }
  if (msg.method === 'callHierarchy/incomingCalls' && typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, result: [{ from: { name: 'callerOne', uri: 'file:///fake/c1.ts', range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } } }, fromRanges: [{ start: { line: 2, character: 4 }, end: { line: 2, character: 13 } }] }, { from: { name: 'callerTwo', uri: 'file:///fake/c2.ts', range: { start: { line: 5, character: 0 }, end: { line: 6, character: 0 } } }, fromRanges: [{ start: { line: 5, character: 4 }, end: { line: 5, character: 13 } }] }] });
    return;
  }
  if (msg.method === 'callHierarchy/outgoingCalls' && typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, result: [{ to: { name: 'helperFn', uri: 'file:///fake/h.ts', range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } } }, toRanges: [{ start: { line: 1, character: 2 }, end: { line: 1, character: 11 } }] }] });
    return;
  }
  if (msg.method === 'textDocument/documentSymbol' && typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, result: [{ name: 'mainFn', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } }, children: [{ name: 'inner', kind: 6, range: { start: { line: 1, character: 2 }, end: { line: 2, character: 2 } } }] }] });
    return;
  }
  if (typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } });
  }
}

fs.writeSync(2, ''); // keep stderr referenced
