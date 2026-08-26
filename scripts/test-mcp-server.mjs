#!/usr/bin/env node
/**
 * Minimal MCP test server (stdio) for hmharness verification.
 * Implements the 2025-06-18 handshake, tools/list and tools/call.
 * Tools: echo (returns its input), hmh_ping (returns "pong <n>").
 * Not shipped as a package - a dev fixture only.
 */
import { createInterface } from 'node:readline';

let toolCallCount = 0;

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'hmh-test-server', version: '0.0.1' },
    });
  } else if (msg.method === 'notifications/initialized') {
    /* notification - no reply */
  } else if (msg.method === 'tools/list') {
    reply(msg.id, {
      tools: [
        {
          name: 'echo',
          description: 'Echo back the given text.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
        {
          name: 'hmh_ping',
          description: 'Test connectivity: returns pong plus the call counter.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ],
    });
  } else if (msg.method === 'tools/call') {
    toolCallCount++;
    if (msg.params.name === 'echo') {
      reply(msg.id, { content: [{ type: 'text', text: String(msg.params.arguments?.text ?? '') }] });
    } else if (msg.params.name === 'hmh_ping') {
      reply(msg.id, { content: [{ type: 'text', text: `pong #${toolCallCount}` }] });
    } else {
      reply(msg.id, { content: [{ type: 'text', text: `unknown tool: ${msg.params.name}` }], isError: true });
    }
  } else if (msg.id !== undefined) {
    reply(msg.id, undefined, { code: -32601, message: `method not found: ${msg.method}` });
  }
});

function reply(id, result, error) {
  const out = { jsonrpc: '2.0', id };
  if (error) out.error = error;
  else out.result = result;
  process.stdout.write(JSON.stringify(out) + '\n');
}
