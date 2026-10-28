/**
 * @hmharness/web - remote/extension routes (extracted from server.ts,
 * 2026-10-17; web split slice 4 per the v33 audit's 4.1 guidance).
 *
 * Eight endpoints: QR rendering, remote-info metadata, the pairing-window
 * feed, pairing rotation, tunnel toggle/switch-line, mobile disconnect, and
 * the read-only extension-bridge probe. Bodies moved VERBATIM; the pairing
 * state group (pairToken/pairExpiresAt/pairPin are module-level `let`s in
 * server.ts that rotatePairing() rewrites) is injected as getters — read at
 * USE sites (deps.pairToken, not a destructured const), so /api/pair/rotate
 * and pair-info's auto-rotate report the state they JUST wrote, and a
 * rotation mid-flight is picked up by any later read.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { patchConfig } from '@hmharness/kernel';
import { tunnel, type TunnelState } from '../tunnel.ts';
import type { WebCfg } from '../server.ts';

export type JsonFn = (res: ServerResponse, status: number, body: unknown) => void;

export interface RemoteRouteDeps {
  cfg: { web?: { exposure?: 'loopback' | 'lan' | 'wan'; token?: string; tunnel?: boolean } };
  port: number;
  exposure: 'loopback' | 'lan' | 'wan';
  json: JsonFn;
  mobileSessions: { size: number; clear(): void };
  trustedLanIps: { size: number; clear(): void };
  rotatePairing: () => void;
  pairingValid: () => boolean;
  persistMobileSessions: () => void;
  preferredLanAddress: () => string;
  requestIsFromLoopbackTransport: (req: IncomingMessage) => boolean;
  requestConnectionMode: (req: IncomingMessage) => 'lan' | 'tunnel';
  sameOriginOk: (req: IncomingMessage) => boolean;
  pairToken: string;
  pairExpiresAt: number;
  pairPin: string;
}

/** Returns true when the request was handled (server.ts stops matching). */
export async function handleRemoteRoute(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  deps: RemoteRouteDeps,
): Promise<boolean> {
  const {
    cfg, port, exposure, json, mobileSessions, trustedLanIps,
    rotatePairing, pairingValid, persistMobileSessions, preferredLanAddress,
    requestIsFromLoopbackTransport, requestConnectionMode, sameOriginOk,
  } = deps;

  if (req.method === 'GET' && url.pathname === '/api/qr') {
    // QR code SVG for phone pairing (docx remote control): rendered by
    // the `qrcode` npm lib (battle-tested, always scannable). The old
    // hand-rolled encoder produced unscannable codes (format-info bug).
    const text = url.searchParams.get('text') ?? '';
    if (!text || text.length > 500) { json(res, 400, { error: 'text required (max 500 chars)' }); return true; }
    try {
      const QR = (await import('qrcode')).default;
      const svg = await QR.toString(text, { type: 'svg', margin: 2, width: 260 });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
      res.end(svg);
      return true;
    } catch (err) {
      json(res, 400, { error: String(err).slice(0, 200) });
      return true;
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/remote-info') {
    // phone pairing helper (docx remote control): the page needs the LAN
    // IP + token to build the QR URL. This is read-only metadata; auth
    // is enforced by the exposure gate above.
    const lanIp = preferredLanAddress();
    const webCfg = (cfg as WebCfg).web ?? {};
    json(res, 200, {
      lanIp,
      token: webCfg.token ?? '',
      exposure: webCfg.exposure ?? 'loopback',
      port,
    });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/pair-info') {
    // Desktop pairing-window feed (DSH snapshot() pattern): one-time
    // pairing URL + countdown + tunnel state. The PIN is only ever sent
    // to the loopback desktop — never to a paired phone or the tunnel.
    if (exposure === 'loopback') { json(res, 400, { error: 'pairing requires --exposure=lan|wan' }); return true; }
    if (!pairingValid()) rotatePairing();
    const t = tunnel.state;
    const lanIp = preferredLanAddress();
    const lanUrl = lanIp ? `http://${lanIp}:${port}/pair?token=${deps.pairToken}` : '';
    const tunnelUrl = t.url ? `${t.url}/pair?token=${deps.pairToken}` : '';
    json(res, 200, {
      lanIp,
      port,
      pairingUrl: t.url ? tunnelUrl : lanUrl,
      lanPairingUrl: lanUrl,
      tunnelPairingUrl: tunnelUrl,
      expiresAt: deps.pairExpiresAt,
      now: Date.now(),
      connected: mobileSessions.size > 0,
      pin: requestIsFromLoopbackTransport(req) && requestConnectionMode(req) === 'lan' ? deps.pairPin : '',
      tunnel: t,
    });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/pair/rotate') {
    rotatePairing();
    json(res, 200, { ok: true, expiresAt: deps.pairExpiresAt });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/tunnel/toggle') {
    if (!requestIsFromLoopbackTransport(req) || requestConnectionMode(req) !== 'lan') {
      json(res, 403, { ok: false, error: 'desktop only' });
      return true;
    }
    if (!sameOriginOk(req)) { json(res, 403, { ok: false, error: 'cross-origin rejected' }); return true; }
    let enable = true;
    try {
      const body = await new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
      if (body) enable = JSON.parse(body).enable !== false;
    } catch { /* default enable */ }
    // persist the intent: a restart must bring the tunnel back, or every
    // printed QR keeps pointing at a dead trycloudflare URL (1033)
    try {
      const cur = ((cfg as WebCfg).web ?? {}) as { exposure?: 'loopback' | 'lan' | 'wan'; token?: string; tunnel?: boolean };
      if ((cur.tunnel ?? false) !== enable) await patchConfig({ web: { ...cur, tunnel: enable } });
      (cfg as WebCfg).web = { ...cur, tunnel: enable };
    } catch { /* config write failed — runtime toggle still applies */ }
    const t: TunnelState = enable
      ? await tunnel.start(port, 'cloudflare', (m) => console.log(m))
      : await tunnel.stop().then(() => tunnel.state);
    json(res, 200, { ok: !t.error, tunnel: t });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/tunnel/switch-line') {
    if (!requestIsFromLoopbackTransport(req) || requestConnectionMode(req) !== 'lan') {
      json(res, 403, { ok: false, error: 'desktop only' });
      return true;
    }
    if (!sameOriginOk(req)) { json(res, 403, { ok: false, error: 'cross-origin rejected' }); return true; }
    const t = await tunnel.switchLine(port, (m) => console.log(m));
    json(res, 200, { ok: !t.error, tunnel: t });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/mobile/disconnect') {
    if (!requestIsFromLoopbackTransport(req) || requestConnectionMode(req) !== 'lan') {
      json(res, 403, { ok: false, error: 'desktop only' });
      return true;
    }
    mobileSessions.clear();
    trustedLanIps.clear();
    rotatePairing();
    persistMobileSessions();
    json(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/extension/status') {
    // Read-only probe of the browser-extension bridge (loopback). The
    // web server takes ZERO new dependencies for this: it speaks plain
    // HTTP to the bridge exactly the way the extension does. Unreachable
    // bridge = honest available:false, never a 500.
    const extPort = Number(process.env.HMH_EXTENSION_PORT ?? 0) || 7789;
    try {
      const r = await fetch(`http://127.0.0.1:${extPort}/v1/status`, { signal: AbortSignal.timeout(1_500) });
      const j = await r.json() as { ok?: boolean; paired?: boolean; connected?: boolean; browser?: string; extVersion?: string };
      if (r.ok && j.ok) {
        json(res, 200, { available: true, port: extPort, paired: j.paired, connected: j.connected, browser: j.browser, extVersion: j.extVersion });
        return true;
      }
    } catch { /* not running */ }
    json(res, 200, { available: false, port: extPort });
    return true;
  }
  return false;
}
