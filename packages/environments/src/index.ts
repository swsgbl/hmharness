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
