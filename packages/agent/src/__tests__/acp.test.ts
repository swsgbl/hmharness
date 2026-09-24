import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessage, validateMessage, AcpServer, AcpClient, type AcpServerConfig } from '../acp.ts';

test('createMessage: valid message', () => {
  const m = createMessage('task', 'agent-a', 'agent-b', { description: 'do something' });
  assert.ok(m.id);
  assert.equal(m.type, 'task');
  assert.equal(m.from, 'agent-a');
  assert.equal(m.to, 'agent-b');
  assert.ok(m.timestamp);
});

test('validateMessage: valid passes', () => {
  const m = createMessage('query', 'a', 'b', {});
  const v = validateMessage(m);
  assert.equal(v.valid, true);
});

test('validateMessage: missing fields fail', () => {
  const v = validateMessage({});
  assert.equal(v.valid, false);
  assert.ok(v.errors.length >= 4);
});

test('AcpServer: registers handlers and advertises capabilities', () => {
  const server = new AcpServer({ agentId: 'hmh', endpoint: 'localhost:8000', capabilities: ['code', 'build', 'test'] });
  server.on('task', async (msg) => createMessage('response', 'hmh', msg.from, { result: 'done' }));
  const caps = server.capabilities();
  assert.equal(caps.agentId, 'hmh');
  assert.ok((caps.capabilities as string[]).includes('code'));
  assert.ok((caps.messageTypes as string[]).includes('task'));
});

test('AcpServer: unhandled type returns error', async () => {
  const server = new AcpServer({ agentId: 'hmh', endpoint: 'x', capabilities: [] });
  const msg = createMessage('task', 'a', 'hmh', {});
  const resp = await server.handle(msg);
  assert.equal(resp.type, 'error');
});

test('AcpClient: discovers by capability', () => {
  const serverConfig: AcpServerConfig = { agentId: 'server-1', endpoint: 'x', capabilities: ['code'] };
  const client = new AcpClient({ agentId: 'client', servers: new Map([['server-1', serverConfig]]) });
  const found = client.discoverByCapability('code');
  assert.equal(found.length, 1);
  assert.equal(found[0].agentId, 'server-1');
  assert.equal(client.discoverByCapability('deploy').length, 0);
});
