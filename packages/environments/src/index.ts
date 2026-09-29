/**
 * @hmharness/environments - Cognitive OS environment adapters
 *
 * Terminal is fully native; HarmonyOS bridges hdc; Browser observes via CDP
 * HTTP with host-bridged actions; Desktop observes windows with host-bridged
 * actions; ARC3 is an honest skeleton awaiting the ARC SDK. All adapters
 * must pass cognitive's EnvironmentRegistry.conformance().
 */
export { TerminalEnvironment, runShell } from './terminal.ts';
export type { TerminalEnvOptions } from './terminal.ts';
export { HarmonyOsEnvironment } from './harmonyos.ts';
export type { HarmonyOsEnvOptions } from './harmonyos.ts';
export { BrowserEnvironment, DesktopEnvironment, Arc3Environment } from './adapters.ts';
export type { BrowserEnvOptions, DesktopEnvOptions, Arc3EnvOptions } from './adapters.ts';
export { Arc3RestBridge, ARC3_BASE } from './arc3-rest.ts';
export type { Arc3Frame, Arc3Game } from './arc3-rest.ts';
export { renderFramePng, gridSummary, ARC3_PALETTE } from './arc3-render.ts';
export { browserActBridge, desktopActBridge } from './bridges.ts';
export type { ToolExecute } from './bridges.ts';
