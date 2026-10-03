/**
 * @hmharness/lsp - LSP Client/Manager for agent code intelligence
 *
 * Client ONLY (master prompt rule): we drive external language servers
 * over stdio (LSP 3.18 subset), never implement one. Security walls live
 * in process-manager (workspace-bound cwd, scrubbed env, restart caps,
 * timeouts). Tier-0 read-only tools in tools.ts; guarded rename/code
 * actions are Tier-3 and NOT implemented here.
 */
export * from './protocol.ts';
export { ProcessManager, scrubEnv, fromPath, type ServerSpec, type ManagedServerOptions } from './process-manager.ts';
export { LspClient, type LspClientOptions } from './client.ts';
export { discoverServers, serverForFile, fileToUri, type DiscoveredServer } from './registry.ts';
export { lspTools, shutdownLsp, diagnosticsSummary, type LspToolContext } from './tools.ts';
export { checkTrust, trustServer, untrustServer, listTrust, serverHash, trustPath, type TrustEntry, type TrustStore, type TrustVerdict } from './trust.ts';
