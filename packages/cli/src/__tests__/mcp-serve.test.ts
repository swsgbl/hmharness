import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient } from '@hmharness/kernel';

/* Loopback test: hmharness' OWN McpClient talks to hmharness' OWN MCP server
 * (hmh mcp-serve). Protocol both ends proven in one process pair. */

const MAIN = join(process.cwd(), 'packages', 'cli', 'src', 'main.ts');

async function connect(extraEnv: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hmh-mcpserve-'));
  const client = new McpClient('hmharness-selftest', {
    type: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', MAIN, 'mcp-serve'],
    env: { HMH_HOME: home, ...extraEnv },
  });
  await client.connect(15_000);
  return { client, home };
}

test('mcp-serve: handshake + tools/list exposes the harmony_* surface only', async () => {
  const { client, home } = await connect();
  try {
    const tools = await client.listTools();
    assert.ok(tools.length >= 10, 'the harmony domain surface is exposed (got ' + tools.length + ')');
    for (const t of tools) {
      assert.match(t.name, /^harmony_/, 'only harmony-prefixed tools are exposed');
      assert.ok(t.description && t.description.length > 0, 'every tool carries a description');
    }
    const names = tools.map((t) => t.name);
    for (const dangerous of ['run_command', 'write_file', 'read_file', 'desktop_click', 'ssh_run', 'spawn_agent']) {
      assert.ok(!names.includes(dangerous), dangerous + ' must stay private');
    }
  } finally {
    client.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('mcp-serve: tools/call round trip (honest output without a device) + unknown tool is an error', async () => {
  const { client, home } = await connect();
  try {
    // a real domain tool: without hdc it must still answer honestly, never crash
    const r = await client.callTool('harmony_devices', {}, 60_000);
    assert.equal(typeof r.output, 'string');
    assert.ok(r.output.length > 0, 'tools/call returns content');

    // unknown tool -> isError
    const bad = await client.callTool('definitely_not_a_tool', {}, 15_000);
    assert.equal(bad.isError, true);

    // every call landed in the observation log (external-agent usage feed)
    const log = await readFile(join(home, 'insights', 'mcp-calls.jsonl'), 'utf8');
    const lines = log.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.tool === 'harmony_devices' && l.ok === true), 'successful call logged');
    assert.ok(lines.some((l) => l.tool === 'definitely_not_a_tool' && l.ok === false), 'failed call logged');
  } finally {
    client.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('mcp-serve: HMH_MCP_TOOLS narrows the exposed surface', async () => {
  const { client, home } = await connect({ HMH_MCP_TOOLS: 'harmony_ops_status' });
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['harmony_ops_status']);
  } finally {
    client.close();
    await rm(home, { recursive: true, force: true });
  }
});
