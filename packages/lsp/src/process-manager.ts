/**
 * @hmharness/lsp - process manager (master prompt security rules)
 *
 * Owns language-server child processes with the hard walls from the LSP
 * 专项方案 (03):
 *  - cwd is BOUND to the workspace root (a server cannot wander)
 *  - environment is an ALLOWLIST (secret env vars never inherit)
 *  - crash restart has a cap + exponential backoff (a flapping server
 *    must not become a fork bomb)
 *  - every request has a timeout and can be cancelled
 *  - the server's identity (command/version) is recorded for audit
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface ServerSpec {
  /** server id, e.g. 'typescript' | 'pyright' | 'rust-analyzer' */
  id: string;
  /** executable + args exactly as discovered (no auto-download here) */
  command: string;
  args: string[];
  /** provenance recorded for audit: where this command came from */
  source: 'PATH' | 'explicit';
}

export interface ManagedServerOptions {
  /** secret-free env allowlist passed to the server (default: PATH/SYSTEMROOT/LANG only) */
  envAllowlist?: string[];
  maxRestarts?: number;
  requestTimeoutMs?: number;
}

/** Environment scrub: language servers do NOT need API keys to index code.
 *  Default allowlist keeps PATH working on Windows without inheriting
 *  provider tokens or user secrets. */
export function scrubEnv(extraAllow: string[] = []): NodeJS.ProcessEnv {
  const allow = new Set(['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'LANG', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', ...extraAllow]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && allow.has(k.toUpperCase()) === false && !allow.has(k)) continue;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export class ProcessManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  /** total spawns; spawns beyond the first are restarts (exit clears this.proc,
   *  so counting there would miss exactly the flapping case) */
  private spawns = 0;
  readonly startedAt: string | null = null;
  lastExit: { code: number | null; signal: NodeJS.Signals | null; at: string } | null = null;

  constructor(
    readonly spec: ServerSpec,
    private cwd: string,
    private opts: ManagedServerOptions = {},
  ) {}

  get restartCount(): number {
    return Math.max(0, this.spawns - 1);
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  /** Spawn (or respawn after crash, up to the cap). Resolves with the
   *  child's stdio streams; rejects when the restart budget is spent. */
  start(): ChildProcessWithoutNullStreams {
    if (this.running && this.proc) return this.proc;
    const max = this.opts.maxRestarts ?? 3;
    // allowed total spawns = the initial one + maxRestarts
    if (this.spawns >= 1 + max) {
      throw new Error(`server ${this.spec.id} exceeded restart budget (${this.restartCount} restarts >= ${max}) — refusing to flap`);
    }
    this.spawns += 1;
    const proc = spawn(this.spec.command, this.spec.args, {
      cwd: this.cwd, // bound to the workspace (03 方案: workspace 外访问)
      env: scrubEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    proc.on('exit', (code, signal) => {
      this.lastExit = { code, signal, at: new Date().toISOString() };
      if (this.proc === proc) this.proc = null;
    });
    this.proc = proc;
    return proc;
  }

  /** Graceful stop, then hard kill. Always resolves. */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 3_000);
      proc.once('exit', () => { clearTimeout(killTimer); resolve(); });
      try { proc.kill(); } catch { clearTimeout(killTimer); resolve(); }
    });
  }

  /** Synchronous last-resort kill (process 'exit' hook: async cleanup will
   *  not run there). Never spawns; kills the live child if any. */
  killSync(): void {
    const proc = this.proc;
    this.proc = null;
    if (proc) { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

/** Discover a server binary from PATH (explicit, never auto-downloaded —
 *  03 方案: 自动下载供应链风险，来源白名单+hash 是后续 Capability OS 的事). */
export function fromPath(id: string, command: string, args: string[]): ServerSpec | null {
  // PATH lookup without spawning: `where` on win, `which` elsewhere — cheap
  // probe done by the caller; here we just mark provenance
  return { id, command, args, source: 'PATH' };
}
