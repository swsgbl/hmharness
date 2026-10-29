/**
 * @hmharness/kernel - http-transport
 * Transport selection for every outbound HTTP call in the kernel: native
 * fetch (undici) when usable, a node:http/https fallback when it is not.
 *
 * Why a fallback exists (device forensics, 2026-10-29): the KaihongOS board
 * must run node with --jitless (RWX pages are forbidden there; a normal
 * build dies instantly). That node build (v24.19.0 musl, jitless) has
 * `typeof WebAssembly === 'undefined'`, and undici's fetch depends on wasm -
 * so EVERY fetch() call throws "fetch failed WebAssembly is not defined"
 * within ~80ms, even to plain localhost HTTP. The kernel's provider
 * chat/chatVision only spoke fetch, so on-board tasks hung forever in the
 * retry loop (runner at 0% CPU). node:http's request() works fine there;
 * this module routes to it automatically whenever fetch is unusable.
 *
 * The fallback deliberately mirrors fetch semantics: same request shape,
 * WHATWG-reader-shaped response bodies (the SSE pumps in provider.ts and
 * mcp.ts consume `getReader(res)` and never learn which transport answered),
 * and network errors normalized to undici's `fetch failed ...` message shape
 * so TRANSIENT_RE retry behavior is identical on both transports.
 * packages/web's own server/tunnel/MCP fetches are out of scope here.
 */
import * as http from 'node:http';
import * as https from 'node:https';

export interface TransportRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** The subset of the WHATWG Response shape the kernel actually uses. Native
 *  fetch responses satisfy it structurally; the node:http fallback wraps an
 *  IncomingMessage to satisfy it by hand. */
export interface TransportResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  body: { getReader(): TransportReader } | null;
}

export interface TransportReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

export type TransportMode = 'fetch' | 'node';

/** The raw probe: fetch must be a function AND WebAssembly must exist
 *  (undici depends on wasm; jitless builds compile it out - exactly the
 *  on-board failure this module exists for). */
export function detectTransportMode(): TransportMode {
  return typeof globalThis.fetch === 'function' && typeof (globalThis as { WebAssembly?: unknown }).WebAssembly !== 'undefined'
    ? 'fetch'
    : 'node';
}

let active: ((url: string, init: TransportRequest) => Promise<TransportResponse>) | undefined;

/** All kernel outbound HTTP goes through here. The transport is probed once
 *  per process (memoized); the fetch path re-resolves globalThis.fetch on
 *  every call so tests and loaders can still substitute it after startup. */
export function httpFetch(url: string, init: TransportRequest = {}): Promise<TransportResponse> {
  if (!active) {
    if (detectTransportMode() === 'fetch') {
      active = (u, i) => globalThis.fetch(u, i as RequestInit) as unknown as Promise<TransportResponse>;
    } else {
      // one-shot, for on-board forensics: proves which transport is live
      console.warn('[chat] fetch unavailable (jitless/no-wasm) — using node:http transport');
      active = nodeFetch;
    }
  }
  return active(url, init);
}

/** Tests only: drop the memo so a mutated globalThis gets re-probed. */
export function __resetTransportForTests(): void {
  active = undefined;
}

/** Tests only: pin the transport. Poisoning globalThis.WebAssembly to steer
 *  the probe is NOT CI-safe across node versions (on 22, an import-time
 *  fetch's deferred undici wasm parse can land inside the poisoned window and
 *  crash the process); pinning exercises the exact same code path without
 *  touching globals. */
export function __forceTransportForTests(mode: TransportMode): void {
  if (mode === 'node') {
    console.warn('[chat] fetch unavailable (jitless/no-wasm) — using node:http transport');
    active = nodeFetch;
  } else {
    active = (u, i) => globalThis.fetch(u, i as RequestInit) as unknown as Promise<TransportResponse>;
  }
}

/** Uniform reader entry for every SSE pump: the fetch path returns the
 *  body's own reader unchanged; the node fallback hands back its adapter. */
export function getReader(res: TransportResponse): TransportReader {
  if (!res.body) throw new TypeError('provider: no response body (streaming requested)');
  return res.body.getReader();
}

// One keep-alive agent per scheme, shared by every call, so the fallback
// matches fetch's connection-reuse behavior (no fresh TCP+TLS handshake per
// chat request).
const keepAliveHttp = new http.Agent({ keepAlive: true });
const keepAliveHttps = new https.Agent({ keepAlive: true });

function normalizeNetError(err: unknown): Error {
  const cause = err instanceof Error ? err.message : String(err);
  return new Error(`fetch failed ${cause}`);
}

/** node:http(s) request() shaped like fetch(). Network-level failures reject
 *  with undici's `fetch failed <cause>` message shape so TRANSIENT_RE /
 *  isTransientTransport retry matching sees identical text on both
 *  transports. Redirects are NOT followed (fetch would follow them), but a
 *  redirect on a chat/completions POST is not a real-world shape. */
function nodeFetch(url: string, init: TransportRequest): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error(`fetch failed invalid URL: ${String(err)}`));
      return;
    }
    const secure = target.protocol === 'https:';
    const req = (secure ? https : http).request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: init.method ?? 'GET',
      headers: init.headers,
      agent: secure ? keepAliveHttps : keepAliveHttp,
    });
    // AbortSignal semantics mirror fetch. Destroying the request alone does
    // NOT reliably emit 'error' on the response stream (a clean local close
    // only emits 'close', which the reader adapter would read as a normal
    // end-of-body and the chat would silently return an empty answer), so
    // the destroy error is also pushed onto the response the moment one
    // exists - the reader then surfaces it as an error through read(), the
    // same way undici surfaces AbortError.
    let resRef: http.IncomingMessage | undefined;
    const onAbort = () => {
      const err = new Error('operation aborted');
      req.destroy(err);
      resRef?.destroy(err);
    };
    const { signal } = init;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('response', (res) => {
      resRef = res;
      // the abort listener deliberately STAYS: fetch's signal covers the
      // whole body-consumption phase, not just until headers arrive (a
      // keep-alive SSE stream must still be pierceable mid-read). The
      // listener dies with the caller's per-request AbortController, so a
      // request that completes without aborting leaks nothing.
      resolve(wrapNodeResponse(res));
    });
    req.on('error', (err) => {
      reject(normalizeNetError(err)); // no-op if the response already resolved; body cuts surface via the reader
    });
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** Adapt an IncomingMessage to the TransportResponse shape: status/headers
 *  pass through, text()/json() buffer the whole body, and body.getReader()
 *  attaches the flowing-mode adapter on first use. A response is consumed
 *  exactly once - buffered OR streamed, never both - the same contract as a
 *  fetch Response. (One exception: a 401 renegotiate in provider.ts drops
 *  the body unread, so that one keep-alive socket is never returned to the
 *  pool - rare, self-limiting, and exactly what the fetch path does too.) */
function wrapNodeResponse(res: http.IncomingMessage): TransportResponse {
  const raw = res.headers as Record<string, string | string[] | undefined>;
  const get = (name: string): string | null => {
    const v = raw[name.toLowerCase()];
    return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
  };
  const readAll = () =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', (e) => reject(normalizeNetError(e)));
    });
  let reader: TransportReader | undefined;
  return {
    status: res.statusCode ?? 0,
    ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
    headers: { get },
    text: readAll,
    json: async () => JSON.parse(await readAll()),
    body: {
      getReader: () => {
        if (!reader) reader = nodeStreamReader(res);
        return reader;
      },
    },
  };
}

/** WHATWG reader adapter over a node stream: chunks land in a queue that
 *  read() drains; 'end'/'close'/cancel() settle pending and future reads as
 *  done (fetch's reader.cancel() resolves pending reads the same way), while
 *  'error' rejects them with the normalized net-error shape so a mid-stream
 *  cut keeps matching TRANSIENT_RE. Buffer IS a Uint8Array; the SSE pumps
 *  hand the bytes straight to TextDecoder and never retain them, so no copy
 *  is made. */
function nodeStreamReader(stream: http.IncomingMessage): TransportReader {
  const queue: Array<{ done?: boolean; value?: Uint8Array } | Error> = [];
  let wake: (() => void) | undefined;
  let finished = false;
  const push = (item: { done?: boolean; value?: Uint8Array } | Error): void => {
    if (finished) return;
    if (item instanceof Error || item.done === true) finished = true;
    queue.push(item);
    wake?.();
    wake = undefined;
  };
  stream.on('data', (c: Buffer) => push({ value: c }));
  stream.on('end', () => push({ done: true }));
  // destroy() mid-body emits no 'error', but reads must not hang either
  stream.on('close', () => push({ done: true }));
  // premature server cut: undici raises `terminated` for this exact shape
  // (TRANSIENT_RE matches it, so the retry loop kicks in on node too)
  stream.on('aborted', () => push(new Error('fetch failed terminated')));
  stream.on('error', (e) => push(normalizeNetError(e)));
  const stop = (): void => {
    finished = true;
    wake?.();
    wake = undefined;
  };
  return {
    async read() {
      for (;;) {
        const item = queue.shift();
        if (item !== undefined) {
          if (item instanceof Error) throw item;
          return item.done === true ? { done: true, value: undefined } : { done: false, value: item.value! };
        }
        if (finished) return { done: true, value: undefined };
        await new Promise<void>((r) => { wake = r; });
      }
    },
    async cancel() {
      stop();
      stream.destroy(); // free the keep-alive socket instead of leaking it on a half-read body
    },
    releaseLock: stop,
  };
}
