/**
 * @hmharness/web - security headers (2026-11-25, modern-web-guidance `security`)
 *
 * Baseline hardening on every response, plus a per-request nonce Content Security
 * Policy on the three HTML documents the server emits. Until this module the
 * server sent no security headers at all.
 *
 * Nonces come from an EXPLICIT placeholder in the developer-authored page
 * (NONCE_SLOT in page/body.ts), never from regex-stamping `<script>` tags of
 * rendered HTML — post-processing cannot tell our tags from injected ones.
 * `PAGE` and `PIN_PAGE` contain no user data, so the swap authorizes exactly the
 * scripts we wrote.
 *
 * Deliberately NOT enforced here: `require-trusted-types-for 'script'`. The page
 * renders through many `innerHTML` sinks (each interpolation escaped with
 * `esc()`); Trusted Types needs those sinks routed through a sanitizing policy
 * first, which is a refactor of its own. Everything else in the guide's
 * mandatory list is below.
 */
import { randomBytes } from 'node:crypto';

export const NONCE_SLOT = '__HMH_NONCE__';

/** Same-origin endpoint the browser posts CSP violation reports to (see reportCspReport). */
export const CSP_REPORT_ENDPOINT = '/api/csp-report';
const REPORT_NAME = 'hmh-csp';

/** On every response. `Permissions-Policy` lists only features the page never uses. */
export const BASE_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
};

export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

/** BASE_HEADERS + the document policy. `connect-src`/`img-src` are `'self'`: the page only
 *  fetches `/api/…` and its one image is the same-origin `/api/qr`. */
export function documentHeaders(nonce: string): Record<string, string> {
  return {
    ...BASE_HEADERS,
    'Content-Security-Policy': [
      `script-src 'nonce-${nonce}' 'strict-dynamic' 'report-sample'`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      `report-to ${REPORT_NAME}`,
    ].join('; '),
    'Reporting-Endpoints': `${REPORT_NAME}="${CSP_REPORT_ENDPOINT}"`,
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  };
}

export function stamp(html: string, nonce: string): string {
  return html.split(NONCE_SLOT).join(nonce);
}

/** Compact one-line summary of a violation report (Reporting API envelope or legacy
 *  report-uri shape). Only the fields that identify the cause; nothing else is kept. */
export function summarizeCspReport(body: unknown): string | null {
  const env = (body ?? {}) as Record<string, unknown>;
  const raw = (env['type'] === 'csp-violation' && env['body'] ? env['body'] : env) as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null) return null;
  const str = (k: string, max: number) => (typeof raw[k] === 'string' ? String(raw[k]).slice(0, max) : '');
  const dir = str('effectiveDirective', 60) || str('violated-directive', 60);
  if (!dir) return null;
  const parts = [`directive=${dir}`, `blocked=${str('blockedURI', 120) || str('blocked-uri', 120) || '?'}`];
  const sample = str('sample', 60);
  if (sample) parts.push(`sample=${JSON.stringify(sample)}`);
  const line = raw['lineNumber'];
  if (typeof line === 'number') parts.push(`line=${line}`);
  const age = env['age'];
  if (typeof age === 'number' && age > 0) parts.push(`age=${age}`);
  return parts.join(' ');
}

/** Phone-side PIN entry page (internet pairing only; minimal, self-contained). Its one
 *  script carries NONCE_SLOT and binds its click handler in JS — an inline `onclick`
 *  would be blocked by the nonce policy. */
export const PIN_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<title>配对 hmh</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#141416;color:#f5f5f6;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.card{width:100%;max-width:320px;padding:28px 24px;text-align:center}
h1{font-size:18px;margin:0 0 6px}
p{color:#95979d;font-size:13px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;padding:12px;font:24px/1 monospace;letter-spacing:8px;text-align:center;border-radius:10px;border:1px solid #33353a;background:#1e2024;color:#f5f5f6;outline:none}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:#2f81f7;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
#st{margin-top:12px;font-size:12px;color:#95979d;min-height:18px}
.err{color:#f85149}
</style></head><body><div class="card"><h1>输入配对密码</h1>
<p>密码显示在电脑上的配对窗口中（6 位数字）</p>
<input id="pin" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="••••••" autofocus>
<button id="go" type="button">连接</button><div id="st"></div>
<script nonce="__HMH_NONCE__">
var st=document.getElementById('st');
document.getElementById('go').addEventListener('click',go);
document.getElementById('pin').addEventListener('keydown',function(e){if(e.key==='Enter')go()});
async function go(){
  var pin=document.getElementById('pin').value.trim();
  if(pin.length!==6){st.className='err';st.textContent='请输入 6 位密码';return}
  st.className='';st.textContent='正在验证…';
  try{
    var r=await fetch('/pair/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:pin})});
    var j=await r.json();
    if(j.ok){st.textContent='配对成功，正在进入…';location.href='/';return}
    st.className='err';st.textContent=j.error||'验证失败';
    if(j.rescan)st.textContent='二维码已过期，请在电脑上重新扫码';
  }catch(e){st.className='err';st.textContent='网络异常，请重试'}
}
</script></div></body></html>`;
