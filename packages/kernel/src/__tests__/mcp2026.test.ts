import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_PROTOCOL_VERSION,
  buildMcpHeaders,
  validateMcpResponseHeaders,
  isCacheableListResponse,
  buildConditionalListRequest,
  isNotModified,
  canTransitionTask,
  validateMcpAuth,
} from '../mcp2026.ts';

test('MCP protocol version is 2026-07-28', () => {
  assert.equal(MCP_PROTOCOL_VERSION, '2026-07-28');
});

test('buildMcpHeaders includes required headers', () => {
  const h = buildMcpHeaders({ sessionId: 'test-123', authorization: 'Bearer tok' });
  assert.equal(h['Mcp-Protocol-Version'], '2026-07-28');
  assert.equal(h['Mcp-Session-Id'], 'test-123');
  assert.equal(h['Authorization'], 'Bearer tok');
  assert.equal(h['Content-Type'], 'application/json');
});

test('buildMcpHeaders omits optional headers when not provided', () => {
  const h = buildMcpHeaders({});
  assert.equal(h['Mcp-Session-Id'], undefined);
  assert.equal(h['Last-Event-Id'], undefined);
  assert.equal(h['Authorization'], undefined);
});

test('validateMcpResponseHeaders passes with correct version', () => {
  const r = validateMcpResponseHeaders({ 'Mcp-Protocol-Version': '2026-07-28' });
  assert.equal(r.valid, true);
  assert.equal(r.issues.length, 0);
});

test('validateMcpResponseHeaders fails with missing version', () => {
  const r = validateMcpResponseHeaders({});
  assert.equal(r.valid, false);
  assert.ok(r.issues.some(i => i.includes('missing')));
});

test('validateMcpResponseHeaders fails with old version', () => {
  const r = validateMcpResponseHeaders({ 'Mcp-Protocol-Version': '2025-01-01' });
  assert.equal(r.valid, false);
  assert.ok(r.issues.some(i => i.includes('unsupported')));
});

test('isCacheableListResponse detects ETag', () => {
  assert.equal(isCacheableListResponse({ ETag: 'abc123' }).cacheable, true);
  assert.equal(isCacheableListResponse({}).cacheable, false);
});

test('buildConditionalListRequest uses If-None-Match', () => {
  const h = buildConditionalListRequest('abc123');
  assert.equal(h['If-None-Match'], 'abc123');
  assert.deepEqual(buildConditionalListRequest(undefined), {});
});

test('isNotModified detects 304', () => {
  assert.equal(isNotModified(304), true);
  assert.equal(isNotModified(200), false);
});

test('task transitions: submitted can go to working', () => {
  assert.equal(canTransitionTask('submitted', 'working'), true);
  assert.equal(canTransitionTask('submitted', 'completed'), false);
});

test('task transitions: working can go to completed or failed', () => {
  assert.equal(canTransitionTask('working', 'completed'), true);
  assert.equal(canTransitionTask('working', 'failed'), true);
  assert.equal(canTransitionTask('working', 'submitted'), false);
});

test('task transitions: terminal states are terminal', () => {
  assert.equal(canTransitionTask('completed', 'working'), false);
  assert.equal(canTransitionTask('cancelled', 'working'), false);
  assert.equal(canTransitionTask('failed', 'working'), false);
});

test('validateMcpAuth: stdio is always authorized', () => {
  const r = validateMcpAuth({ type: 'stdio' });
  assert.equal(r.authorized, true);
});

test('validateMcpAuth: HTTP requires Authorization', () => {
  const r = validateMcpAuth({ type: 'http' });
  assert.equal(r.authorized, false);
  assert.ok(r.reason.includes('requires'));
});

test('validateMcpAuth: HTTP with Bearer is valid', () => {
  const r = validateMcpAuth({ type: 'http', headers: { Authorization: 'Bearer tok' } });
  assert.equal(r.authorized, true);
});

test('validateMcpAuth: HTTP with invalid scheme is rejected', () => {
  const r = validateMcpAuth({ type: 'http', headers: { Authorization: 'ApiKey tok' } });
  assert.equal(r.authorized, false);
});
