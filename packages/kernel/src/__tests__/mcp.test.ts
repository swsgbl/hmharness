import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { McpClient, sanitizeToolName, mcpServerTools } from '../mcp.ts';

test('sanitizeToolName strips invalid chars, keeps dash and underscore', () => {
  assert.equal(sanitizeToolName('a.b-c d'), 'a_b-c_d');
  assert.equal(sanitizeToolName('x/y\\z'), 'x_y_z');
});

test('McpClient: stdio handshake + tools/list + tools/call round trip', async () => {
  const server = join(process.cwd(), 'scripts', 'test-mcp-server.mjs');
  const { client, tools } = await mcpServerTools('ut', { type: 'stdio', command: process.execPath, args: [server] });
  try {
    assert.ok(tools.length >= 2, 'echo + ping projected');
    assert.ok(tools.every((t) => t.name.startsWith('mcp_ut_')));
    assert.ok(tools.every((t) => typeof t.needsApproval === 'function'), 'untrusted server tools are gated');
    const echo = tools.find((t) => t.name === 'mcp_ut_echo')!;
    const r = await echo.execute({ text: '你好' }, { cwd: '.', home: '.' });
    assert.equal(r.output, '你好');
    const ping = tools.find((t) => t.name === 'mcp_ut_hmh_ping')!;
    const p = await ping.execute({}, { cwd: '.', home: '.' });
    assert.match(p.output, /^pong #/);
  } finally {
    client.close();
  }
});

test('McpClient reports a clear error when the server cannot start', async () => {
  const c = new McpClient('bad', { type: 'stdio', command: 'definitely-not-a-real-exe-xyz', args: [] });
  await assert.rejects(() => c.connect(5000));
  void spawn; // keep import symmetric
});
