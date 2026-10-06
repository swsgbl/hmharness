/**
 * @hmharness/extension - browser-extension bridge for mainstream browsers
 *
 * Public surface: protocol types, pairing/token store, the loopback
 * bridge server, agent-side client + discovery + tools, the cross-browser
 * manifest matrix, and the unpacked-directory builder.
 */
export {
  PROTOCOL_VERSION,
  type BridgeCommand,
  type BridgeStatus,
  type PageAct,
  type PageSnapshot,
  type RawPageData,
  type TabInfo,
  type UplinkMessage,
} from './protocol.ts';
export {
  MAX_TOKENS, isPaired, mintAndPinToken, pairedCount, pairingPath, touchLastSeen, unpair, verifyToken,
  type PairingStore,
} from './token.ts';
export {
  DEFAULT_BRIDGE_PORT, ExtensionBridgeServer, bridgePort, probeBridge, readBridgeState, stateFilePath,
  type BridgeStateFile, type ChatTurn, type ChatTurnInput,
} from './bridge.ts';
export { agentCommand, bridgeFromState, bridgeStatus, type BridgeHandle } from './client.ts';
export {
  discoverExtensionBridge, discoverExtensionBridgeSync,
  type DiscoveredExtensionBridge,
} from './registry.ts';
export { extensionTools, type ExtensionToolContext } from './tools.ts';
export { formatPageSnapshot, summarizePage } from './page.ts';
export {
  EXTENSION_ID, EXTENSION_KEY, EXTENSION_TARGETS, EXTENSION_VERSION, GECKO_ID, TARGET_SPECS, manifestFor, validateManifest,
  type ExtensionTarget, type ManifestOptions, type TargetSpec,
} from './adapters.ts';
export { buildExtension, payloadDir, PAYLOAD_FILES, type BuildOptions, type BuildResult } from './build.ts';
export {
  CHROMIUM_REG_HIVES, buildCarriesPinnedKey, discoverInstallTargets, findInstallableBrowsers,
  installExtension, installShortcuts, installedEverywhere, stableInstallDir, uninstallExtension,
  type InstallableBrowser, type InstallOutcome, type InstallResult,
} from './install.ts';
