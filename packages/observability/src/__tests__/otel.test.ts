import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTraceId, generateSpanId, createSpan, finishSpan, buildTrace, toOtlpJson, formatTrace } from '../otel.ts';

test('generateTraceId: 32 hex chars', () => {
  const id = generateTraceId();
  assert.equal(id.length, 32);
  assert.ok(/^[0-9a-f]+$/.test(id));
});

test('generateSpanId: 16 hex chars', () => {
  const id = generateSpanId();
  assert.equal(id.length, 16);
  assert.ok(/^[0-9a-f]+$/.test(id));
});

test('createSpan: root span has no parent', () => {
  const s = createSpan('test-op', 'agent');
  assert.ok(s.traceId);
  assert.ok(s.spanId);
  assert.equal(s.parentSpanId, undefined);
  assert.equal(s.status, 'unset');
});

test('createSpan: child inherits traceId', () => {
  const parent = createSpan('parent', 'agent');
  const child = createSpan('child', 'sandbox', 'internal', parent);
  assert.equal(child.traceId, parent.traceId);
  assert.equal(child.parentSpanId, parent.spanId);
});

test('finishSpan: sets endTime and status', () => {
  const s = createSpan('op', 'agent');
  const f = finishSpan(s, 'ok');
  assert.ok(f.endTime !== undefined);
  assert.equal(f.status, 'ok');
});

test('buildTrace: groups spans by traceId', () => {
  const root = createSpan('root', 'agent');
  const child = createSpan('child', 'mcp', 'client', root);
  const trace = buildTrace([root, child]);
  assert.ok(trace);
  assert.equal(trace!.spans.length, 2);
  assert.equal(trace!.rootSpan.name, 'root');
});

test('buildTrace: mixed traceIds rejected', () => {
  const s1 = createSpan('a', 'agent');
  const s2 = createSpan('b', 'agent'); // different traceId
  assert.equal(buildTrace([s1, s2]), undefined);
});

test('toOtlpJson: produces valid JSON structure', () => {
  const s = finishSpan(createSpan('test', 'agent'), 'ok');
  const json = JSON.parse(toOtlpJson([s]));
  assert.ok(json.resourceSpans);
  assert.ok(json.resourceSpans[0].scopeSpans[0].spans.length > 0);
});

test('formatTrace: renders tree', () => {
  const root = finishSpan(createSpan('main', 'agent'), 'ok');
  const child = finishSpan(createSpan('tool-call', 'sandbox', 'client', root), 'error', 'timeout');
  const trace = buildTrace([root, child])!;
  const text = formatTrace(trace);
  assert.ok(text.includes('main'));
  assert.ok(text.includes('tool-call'));
  assert.ok(text.includes('❌'));
});
