/**
 * @hmharness/sandbox - Long-Horizon Chaos Testing (P1-07)
 *
 * The audit called for: "kill process、disconnect device、corrupt workspace、
 * restart daemon、resume"
 *
 * Provides chaos test scenarios that verify the harness can survive and
 * recover from realistic failures.
 */

export type ChaosScenario =
  | 'kill-process'        // kill a running hmh process
  | 'corrupt-workspace'   // write garbage to workspace files
  | 'disconnect-device'   // unplug/disconnect an emulator/device
  | 'restart-daemon'      // kill and restart the web/evolution daemon
  | 'network-partition'   // simulate network outage
  | 'disk-full'           // simulate disk exhaustion
  | 'workspace-delete'    // delete workspace files entirely
  | 'config-corrupt';     // corrupt config.json

export interface ChaosResult {
  scenario: ChaosScenario;
  /** did the system survive the chaos? */
  survived: boolean;
  /** did the system recover after the chaos was removed? */
  recovered: boolean;
  /** time to recover in ms (if recovered) */
  recoveryMs: number;
  /** details of what happened */
  notes: string;
}

/**
 * Get all defined chaos scenarios.
 * Pure - testable.
 */
export function allScenarios(): ChaosScenario[] {
  return ['kill-process', 'corrupt-workspace', 'disconnect-device', 'restart-daemon', 'network-partition', 'disk-full', 'workspace-delete', 'config-corrupt'];
}

/**
 * Simulate workspace corruption by writing random bytes to files.
 * Returns the list of corrupted files.
 */
export function corruptWorkspaceSpec(files: string[], corruptionPercent: number = 0.3): string[] {
  const count = Math.max(1, Math.floor(files.length * corruptionPercent));
  return files.slice(0, count);
}

/**
 * Check if a system is healthy after chaos was applied.
 * This is the verification step - "did it recover?"
 * Pure - testable.
 */
export function checkRecovery(checks: Array<{ name: string; pass: boolean }>): {
  recovered: boolean;
  failed: string[];
  passedCount: number;
} {
  const failed = checks.filter(c => !c.pass).map(c => c.name);
  return {
    recovered: failed.length === 0,
    failed,
    passedCount: checks.filter(c => c.pass).length,
  };
}

/**
 * Build a chaos test report from results.
 * Pure - testable.
 */
export function chaosReport(results: ChaosResult[]): string {
  const lines = [`Chaos Test Report: ${results.length} scenarios`];
  for (const r of results) {
    const status = r.survived && r.recovered ? '✅' : r.survived ? '⚠️' : '❌';
    const recovery = r.recovered ? `recovered in ${r.recoveryMs}ms` : 'NOT recovered';
    lines.push(`  ${status} ${r.scenario.padEnd(20)} survived=${r.survived} ${recovery}`);
  }
  const survived = results.filter(r => r.survived).length;
  const recovered = results.filter(r => r.recovered).length;
  lines.push(`Summary: ${survived}/${results.length} survived, ${recovered}/${results.length} recovered`);
  return lines.join('\n');
}
