/**
 * @hmharness/extension - cross-browser manifest matrix (2026-10 research)
 *
 * One extension payload, three manifest shapes — the per-browser deltas
 * that actually matter in MV3 (2026 state of the art):
 *
 *  chromium (Chrome/Edge/Brave — one payload, three stores)
 *    - background: { service_worker } — MV2 background pages are dead
 *    - side_panel (Chrome 114+; minimum_chrome_version 116 pins the set)
 *  firefox
 *    - background: { scripts } — Firefox DELIBERATELY does not support
 *      service workers for MV3; the same background.js runs as a
 *      non-persistent event page (feature parity via the `api` shim)
 *    - sidebar_action (Firefox's own key; no side_panel)
 *    - browser_specific_settings.gecko.id — required for storage to work
 *      reliably across installs; strict_min_version 121 = mature MV3
 *    - MV3 host_permissions are granted per-site by the USER in Firefox:
 *      first page.read on a new site may need the user to grant access
 *      (extension settings → Permissions) — honest degradation, stated
 *      in the popup, not silently swallowed
 *  safari
 *    - same core (MV3 since Safari 15.4); NO side panel API exists — the
 *      popup surface is the UI. Apple's native messaging (app-container
 *      only) is why the bridge transport is loopback HTTP: the payload
 *      survives `xcrun safari-web-extension-converter` unchanged.
 *      Payload-compatible = declared; NOT exercised on macOS in CI.
 */
export type ExtensionTarget = 'chromium' | 'firefox' | 'safari';
export const EXTENSION_TARGETS: ExtensionTarget[] = ['chromium', 'firefox', 'safari'];

export const EXTENSION_VERSION = '0.23.22'; // bump with package releases
export const GECKO_ID = 'bridge@hmharness.dev';

/**
 * Fixed public key (round 42) — pins the extension ID across browsers,
 * install paths and install channels: lceccbmgohpgfgckenddombndnklbafm.
 * Without it, an unpacked extension's ID is derived from its folder path,
 * which makes REGISTRY-based persistent installs impossible (the registry
 * key must name the ID) and breaks deep-links/settings references the
 * moment the folder moves. The private half is never needed (we ship
 * unpacked); this is the standard Chrome-webstore-style id pinning.
 */
export const EXTENSION_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4q3ILDDKZOiEgNrQDc7ljtWiTzt3tSsbgnpgvTgZNh7L4BjU+4Evad1arNin/IN6LKyS7pyJoFL6vaEApk+KZdRJQ8a6Um4IanqAIz+OLDm5NjpHqlvlPBREHb5bDASfz5awT6CiE/cZxT42AgeMFOzYszSGNUQlpp+2mFmE2EJ9iSHUUu1ipVYj1IDko0SIP8PNqbiPy+b2AGLV6FWfCLsHzaIlEJAB02uusMdXOUaNUkG4/FrRT++iYKREmhwONZgDA788fiHIQZ35hYQ3GBPiFubZuOsDxAzIROajwbTkw0sk5/Iq0NH/C7swho18sWmYw6lbBzXVwxDURvMQ5wIDAQAB';

/** The ID pinned by EXTENSION_KEY (sha256(pubkey-der) → a-p mapping). */
export const EXTENSION_ID = 'lceccbmgohpgfgckenddombndnklbafm';

export interface TargetSpec {
  id: ExtensionTarget;
  /** browsers this target loads in unchanged */
  label: string;
  /** how the user loads the built directory */
  loadHint: string;
  /** honest caveats — shown by `hmh extension build` */
  notes: string[];
}

export const TARGET_SPECS: Record<ExtensionTarget, TargetSpec> = {
  chromium: {
    id: 'chromium',
    label: 'Chrome / Edge / Brave (Chromium 内核)',
    loadHint: 'chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择构建目录（Edge: edge://extensions，Brave: brave://extensions）',
    notes: ['MV3 service worker;侧栏(side panel)与弹窗两种界面'],
  },
  firefox: {
    id: 'firefox',
    label: 'Firefox',
    loadHint: 'about:debugging#/runtime/this-firefox → 临时载入附加组件 → 选择构建目录中的 manifest.json',
    notes: [
      'Firefox MV3 用非持久事件页(不支持 service worker)——同一 background.js 双形态兼容',
      'MV3 主机权限在 Firefox 由用户按站点授予:首次读取新站点若失败,在扩展设置 → 权限中授予',
      '侧栏对应 sidebar_action;若无侧栏入口,视图 → 工具栏 → 定制中添加',
    ],
  },
  safari: {
    id: 'safari',
    label: 'Safari (macOS)',
    loadHint: 'xcrun safari-web-extension-converter <构建目录> 生成 Xcode 工程 → 签名运行 → Safari 设置 → 扩展中启用',
    notes: [
      'Safari 无 side panel API——UI 走 popup(与 Chrome/Firefox 同一文件)',
      '载荷级兼容(payload-compatible):转换/签名流程未在 CI 实测(无 macOS 环境)——如实声明',
    ],
  },
};

export interface ManifestOptions {
  port: number;
  version?: string;
}

/** Target-specific manifest (the matrix above, as data). */
export function manifestFor(target: ExtensionTarget, opts: ManifestOptions): Record<string, unknown> {
  const version = opts.version ?? EXTENSION_VERSION;
  const common = {
    manifest_version: 3,
    name: 'hmharness 浏览器桥接',
    version,
    // fixed ID pinning (registry installs + stable references)
    key: EXTENSION_KEY,
    description: '将 hmharness 智能体接入你的真实浏览器:读取标签页/页面内容,经逐次批准后操作页面。本机回环通信,无遥测。',
    permissions: ['activeTab', 'scripting', 'tabs', 'storage', 'alarms'],
    // 127.0.0.1:<port> = the bridge itself. <all_urls> = page read/act on
    // the user's REAL pages — the entire point of this extension; the
    // browser's own site-access control (toolbar icon → 站点访问权限)
    // remains the user's kill switch. MV3 fact (2026, multi-browser e2e):
    // scripting.executeScript is REFUSED on any host outside this list —
    // "Cannot access contents of url" — no amount of user consent in the
    // popup can substitute for the manifest declaration.
    host_permissions: [`http://127.0.0.1:${opts.port}/*`, '<all_urls>'],
    action: {
      default_title: 'hmharness 桥接',
      default_popup: 'popup.html',
    },
  };
  if (target === 'chromium') {
    return {
      ...common,
      minimum_chrome_version: '116',
      background: { service_worker: 'background.js' },
      side_panel: { default_path: 'sidepanel.html' },
    };
  }
  if (target === 'firefox') {
    return {
      ...common,
      background: { scripts: ['background.js'] },
      sidebar_action: { default_panel: 'sidepanel.html', default_title: 'hmharness 桥接', open_at_install: false },
      browser_specific_settings: { gecko: { id: GECKO_ID, strict_min_version: '121' } },
    };
  }
  // safari: no side_panel key (unsupported), popup-only surface
  return {
    ...common,
    background: { service_worker: 'background.js' },
  };
}

/** Machine-check a generated manifest for the incompatibility matrix —
 *  anti-theater: a manifest that violates its own target's constraints
 *  fails HERE (and in build tests), not in a browser at load time. */
export function validateManifest(target: ExtensionTarget, manifest: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const m = manifest as Record<string, any>;
  if (m.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (target === 'chromium') {
    if (!m.background?.service_worker) problems.push('chromium needs background.service_worker');
    if (!m.side_panel?.default_path) problems.push('chromium needs side_panel');
  }
  if (target === 'firefox') {
    if (m.background?.service_worker) problems.push('firefox must NOT declare background.service_worker (event page scripts only)');
    if (!Array.isArray(m.background?.scripts) || m.background.scripts.length === 0) problems.push('firefox needs background.scripts');
    if (!m.sidebar_action?.default_panel) problems.push('firefox needs sidebar_action');
    if (!m.browser_specific_settings?.gecko?.id) problems.push('firefox needs browser_specific_settings.gecko.id');
  }
  if (target === 'safari') {
    if (m.side_panel) problems.push('safari has no side_panel support — popup only');
    if (m.sidebar_action) problems.push('safari has no sidebar_action — popup only');
  }
  const host = JSON.stringify(m.host_permissions ?? []);
  if (!host.includes('127.0.0.1')) problems.push('host_permissions must cover 127.0.0.1 (loopback bridge)');
  if (!host.includes('<all_urls>')) problems.push('host_permissions must include <all_urls> — page read/act is REFUSED on any host the manifest does not declare (MV3 hard boundary, multi-browser verified)');
  return problems;
}
