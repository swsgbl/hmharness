/**
 * @hmharness/browser - BrowserOS driver for the agent
 *
 * Client ONLY: we discover, trust-pin, launch and DRIVE the BrowserOS AI
 * browser (Chromium fork) over the Chrome DevTools Protocol — we never
 * touch the user's daily browser (dedicated profile under HMH_HOME,
 * loopback CDP only). Supply-chain guard in trust.ts (same contract as
 * @hmharness/lsp); agent surface in tools.ts (browser_* family).
 */
export { discoverBrowsers, detectRunning, browserosRoots, browserosUserDataDir, BROWSEROS_INSTALL_URL, BROWSEROS_REPO_URL, type DiscoveredBrowser, type RunningDetection } from './registry.ts';
export { checkBrowserTrust, trustBrowser, untrustBrowser, listBrowserTrust, browserHash, browserTrustPath, type BrowserTrustEntry, type BrowserTrustStore, type BrowserTrustVerdict } from './trust.ts';
export { CdpBrowser, type CdpTabInfo, type CdpBrowserOptions } from './cdp.ts';
export { startBrowser, stopBrowser, ownedInstance, clientForInstance, killTree, DEFAULT_CDP_PORT, type OwnedInstance, type StartBrowserOptions } from './lifecycle.ts';
export { SNAPSHOT_EXPR, READ_EXPR, clickExpr, typeExpr, scrollExpr, parseSnapshot, parseRead, formatSnapshot, type Snapshot, type SnapshotElement, type ReadResult } from './page.ts';
export { browserTools, shutdownBrowser, type BrowserToolContext } from './tools.ts';
