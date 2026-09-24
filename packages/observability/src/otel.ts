/**
 * @hmharness/observability - OpenTelemetry-Compatible Traces (P2-06)
 *
 * The audit called for: "跨 Agent / Sandbox / MCP / Device 的统一 trace identity"
 *
 * Provides OTel-compatible span and trace structures so hmharness operations
 * can be exported to any OTel collector (Jaeger, Zipkin, Grafana Tempo).
 */

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

export type SpanStatus = 'unset' | 'ok' | 'error';

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number; // unix ms
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  status: SpanStatus;
  statusMessage?: string;
  /** hmharness-specific: which component produced this span */
  component: 'agent' | 'sandbox' | 'mcp' | 'device' | 'evolution' | 'web' | 'cli';
}

export interface OtelTrace {
  traceId: string;
  rootSpan: OtelSpan;
  spans: OtelSpan[];
}

/**
 * Generate a valid OTel trace ID (32 hex chars).
 * Pure - testable.
 */
export function generateTraceId(): string {
  let id = '';
  for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

/**
 * Generate a valid OTel span ID (16 hex chars).
 * Pure - testable.
 */
export function generateSpanId(): string {
  let id = '';
  for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

/**
 * Create a new span.
 * Pure - testable.
 */
export function createSpan(
  name: string,
  component: OtelSpan['component'],
  kind: SpanKind = 'internal',
  parent?: OtelSpan,
  attributes: Record<string, string | number | boolean> = {},
): OtelSpan {
  return {
    traceId: parent?.traceId ?? generateTraceId(),
    spanId: generateSpanId(),
    parentSpanId: parent?.spanId,
    name, kind, component, attributes,
    startTime: Date.now(),
    status: 'unset',
  };
}

/**
 * Finish a span (sets endTime and status).
 * Pure - testable.
 */
export function finishSpan(span: OtelSpan, status: SpanStatus = 'ok', message?: string): OtelSpan {
  return {
    ...span,
    endTime: Date.now(),
    status,
    ...(message ? { statusMessage: message } : {}),
  };
}

/**
 * Build a complete trace from spans.
 * Pure - testable.
 */
export function buildTrace(spans: OtelSpan[]): OtelTrace | undefined {
  if (spans.length === 0) return undefined;
  const traceId = spans[0].traceId;
  if (!spans.every(s => s.traceId === traceId)) return undefined;
  const root = spans.find(s => !s.parentSpanId) ?? spans[0];
  return { traceId, rootSpan: root, spans };
}

/**
 * Export spans in OTLP JSON format (what OTel collectors accept).
 * Pure - testable.
 */
export function toOtlpJson(spans: OtelSpan[]): string {
  return JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'hmharness' } }] },
      scopeSpans: [{
        spans: spans.map(s => ({
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId,
          name: s.name,
          kind: s.kind,
          startTimeUnixNano: String(s.startTime * 1_000_000),
          endTimeUnixNano: s.endTime ? String(s.endTime * 1_000_000) : undefined,
          attributes: Object.entries(s.attributes).map(([k, v]) => ({
            key: k,
            value: typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? { doubleValue: v } : { boolValue: v },
          })),
          status: { code: s.status === 'ok' ? 1 : s.status === 'error' ? 2 : 0 },
        })),
      }],
    }],
  }, null, 2);
}

/**
 * Format a trace as a readable tree.
 * Pure - testable.
 */
export function formatTrace(trace: OtelTrace): string {
  const lines = [`Trace ${trace.traceId.slice(0, 16)}... (${trace.spans.length} spans)`];
  const byParent = new Map<string | undefined, OtelSpan[]>();
  for (const s of trace.spans) {
    const key = s.parentSpanId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(s);
  }
  function render(span: OtelSpan, indent: number): void {
    const dur = span.endTime ? `${span.endTime - span.startTime}ms` : '...';
    const status = span.status === 'error' ? '❌' : span.status === 'ok' ? '✅' : '⏳';
    lines.push(`${'  '.repeat(indent)}${status} ${span.name} [${span.component}] ${dur}`);
    for (const child of byParent.get(span.spanId) ?? []) render(child, indent + 1);
  }
  render(trace.rootSpan, 0);
  return lines.join('\n');
}
