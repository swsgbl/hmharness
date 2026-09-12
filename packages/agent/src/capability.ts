/**
 * @hmharness/agent - capability plane (V2 blueprint M4).
 *
 * Projects every registered tool - native, MCP, domain - onto a
 * CapabilityManifest: an auditable declaration of id, risk, permissions,
 * approval requirement and side effects. The PolicyEngine then answers
 * "may this capability run in this mode?" for lockdown/standard modes.
 * This is the DECLARATION layer on top of the existing enforcement layer
 * (kernel needsApproval + shellgate + DENY_PATTERNS stay authoritative);
 * manifests make the security surface inspectable (`hmh capability list`).
 */
import type { Tool } from '@hmharness/kernel';

export type CapabilityRisk = 'low' | 'medium' | 'high' | 'critical';

export interface CapabilityManifest {
  id: string;
  version: string;
  description: string;
  risk: CapabilityRisk;
  /** coarse permission buckets derived from the tool's nature */
  permissions: string[];
  requiresApproval: boolean;
  network: boolean;
  sideEffects: string[];
}

/** Tool-name heuristics -> permission buckets and risk. Declaration only -
 *  enforcement stays in kernel (needsApproval/shellgate/DENY_PATTERNS). */
const RISK_RULES: Array<{ match: RegExp; risk: CapabilityRisk; permissions: string[]; network: boolean; sideEffects: string[] }> = [
  { match: /^(run_command|ssh_run)$/, risk: 'high', permissions: ['process.spawn', 'fs.read', 'fs.write', 'net.remote'], network: true, sideEffects: ['host-process', 'remote-exec'] },
  { match: /^(write_file|edit_file)$/, risk: 'medium', permissions: ['fs.write'], network: false, sideEffects: ['file-mutation'] },
  { match: /^desktop_(click|type)$/, risk: 'high', permissions: ['desktop.control'], network: false, sideEffects: ['host-ui-input'] },
  { match: /^desktop_screenshot$/, risk: 'medium', permissions: ['desktop.read'], network: false, sideEffects: [] },
  { match: /^(browser_open|web_search|web_fetch)$/, risk: 'low', permissions: ['net.egress'], network: true, sideEffects: [] },
  { match: /^(harmony_install|harmony_launch|harmony_uninstall|harmony_sign)$/, risk: 'high', permissions: ['device.write'], network: false, sideEffects: ['device-mutation'] },
  { match: /^(harmony_emulator_(create|start|stop|delete))$/, risk: 'high', permissions: ['device.write', 'process.spawn'], network: true, sideEffects: ['device-mutation'] },
  { match: /^(harmony_build|harmony_cjpm_build|harmony_cjpm_test|harmony_lint)$/, risk: 'medium', permissions: ['process.spawn', 'fs.write'], network: true, sideEffects: ['build-artifacts'] },
  { match: /^spawn_agent$/, risk: 'high', permissions: ['agent.spawn'], network: false, sideEffects: ['subagent-run'] },
];

export function manifestFor(tool: Tool): CapabilityManifest {
  const rule = RISK_RULES.find((r) => r.match.test(tool.name));
  const requiresApproval = typeof tool.needsApproval === 'function';
  return {
    id: tool.name,
    version: '1.0.0',
    description: tool.description.split('\n')[0].slice(0, 160),
    risk: rule?.risk ?? (requiresApproval ? 'medium' : 'low'),
    permissions: rule?.permissions ?? (requiresApproval ? ['gated.unknown'] : ['fs.read']),
    requiresApproval,
    network: rule?.network ?? false,
    sideEffects: rule?.sideEffects ?? [],
  };
}

export function capabilityReport(registry: { list(): Tool[] }): CapabilityManifest[] {
  return registry.list().map(manifestFor).sort((a, b) => a.id.localeCompare(b.id));
}

/* ---------------- policy engine ---------------- */

export type PolicyMode = 'standard' | 'lockdown';

export interface PolicyDecision {
  allow: boolean;
  reason: string;
}

/** Lockdown mode: anything with host/device/process reach is denied outright;
 *  approval-gated capabilities still require their gate. Standard mode:
 *  mirrors the existing enforcement (declaration-only view). */
export function authorize(manifest: CapabilityManifest, mode: PolicyMode, deniedIds: ReadonlySet<string> = new Set()): PolicyDecision {
  if (deniedIds.has(manifest.id)) return { allow: false, reason: `capability revoked: ${manifest.id}` };
  if (mode === 'lockdown') {
    const dangerous = manifest.permissions.some((p) => p.startsWith('process.') || p.startsWith('device.write') || p.startsWith('desktop.control') || p.startsWith('net.remote') || p.startsWith('agent.'));
    if (dangerous) return { allow: false, reason: `lockdown: ${manifest.id} touches ${manifest.permissions.filter((p) => !p.startsWith('fs.')).join(', ')}` };
  }
  return { allow: true, reason: manifest.requiresApproval ? 'allowed, approval gate applies' : 'allowed' };
}
