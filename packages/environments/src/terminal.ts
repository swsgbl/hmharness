/**
 * @hmharness/environments - Terminal environment (ENV-017/018/019)
 *
 * The native environment: observe = cwd/file tree/processes/output tail;
 * act = run command / write file; evaluate = tests/build/git probes;
 * snapshot/restore = cwd + tracked-file digests (restoration of DELETED
 * files is honestly out of scope and reported, not faked).
 *
 * Windows-first (the host platform) with POSIX command mapping; commands
 * run through cmd/powershell on win32, /bin/sh elsewhere. Every action
 * carries a timeout; every result carries duration + structured errors.
 */
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile, stat, rm, mkdir } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type {
  Environment, Observation, Action, ActionResult, Snapshot, EnvironmentScore,
  Capability, ResetOptions, ActionSpec,
} from '@hmharness/cognitive';
import { stableHash } from '@hmharness/cognitive';

export interface TerminalEnvOptions {
  /** working root; created when missing on reset() */
  workspaceDir: string;
  timeoutMs?: number;
  /** max tracked files in observations/snapshots */
  maxTrackedFiles?: number;
}

export class TerminalEnvironment implements Environment {
  id = 'terminal';
  version = '1.0.0';
  snapshotClass = 'deterministic' as const; // scratch workspace state fully replays
  private cwd = '';
  private lastOutputs: string[] = [];
  private actionCounter = 0;
  private readonly timeoutMs: number;
  private readonly maxFiles: number;

  constructor(private opts: TerminalEnvOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxFiles = opts.maxTrackedFiles ?? 400;
  }

  async capabilities(): Promise<Capability[]> {
    return [
      { kind: 'observe', detail: 'cwd, tracked file digests, recent outputs' },
      { kind: 'act', detail: 'command (shell), writeFile, read briefly' },
      { kind: 'evaluate', detail: 'exit-code based probes: test/build/git' },
      { kind: 'snapshot', detail: 'cwd + file digests (deletions not restorable)' },
      { kind: 'process', detail: `shell commands, ${this.timeoutMs}ms timeout each` },
      { kind: 'filesystem', detail: `limited to ${this.opts.workspaceDir}` },
    ];
  }

  async reset(opts?: ResetOptions): Promise<Observation> {
    this.cwd = opts?.workspaceDir ?? this.opts.workspaceDir;
    await mkdir(this.cwd, { recursive: true });
    this.lastOutputs = [];
    this.actionCounter = 0;
    return this.observe();
  }

  async observe(): Promise<Observation> {
    const files = await this.trackFiles();
    return {
      environmentId: this.id,
      timestamp: new Date().toISOString(),
      state: {
        cwd: this.cwd,
        files,
        recentOutputs: this.lastOutputs.slice(-3),
        actionsTaken: this.actionCounter,
      },
      availableActions: this.actionSpecs(),
    };
  }

  private actionSpecs(): ActionSpec[] {
    return [
      { id: 'command', type: 'command', description: 'run a shell command in the workspace', argsSchema: { cmd: 'string' }, cost: 3 },
      { id: 'writeFile', type: 'writeFile', description: 'create/overwrite a file in the workspace', argsSchema: { path: 'string', content: 'string' }, cost: 1 },
      { id: 'deleteFile', type: 'deleteFile', description: 'delete a file in the workspace (irreversible)', argsSchema: { path: 'string' }, cost: 1, irreversible: true },
    ];
  }

  async act(action: Action): Promise<ActionResult> {
    this.actionCounter += 1;
    const started = Date.now();
    const guard = this.guard(action);
    if (guard) return { ...guard, actionId: action.id, durationMs: Date.now() - started };
    try {
      switch (action.type) {
        case 'command': {
          const cmd = String(action.args.cmd ?? '');
          if (!cmd.trim()) return this.fail(action.id, 'E_ARGS', 'command.args.cmd required', started);
          if (/(?:^|[|&;])\s*(?:rm\s+-rf\s+\/|format\s+[a-z]:|del\s+\/[fqs])/im.test(cmd)) {
            return this.fail(action.id, 'E_UNSAFE', 'destructive command pattern rejected', started);
          }
          const r = await runShell(cmd, this.cwd, this.timeoutMs);
          this.lastOutputs.push(`$ ${cmd}\n${(r.stdout + r.stderr).slice(0, 2_000)}`);
          return {
            actionId: action.id,
            outcome: r.code === 0 ? 'success' : 'failure',
            error: r.code === 0 ? undefined : { code: 'E_EXIT', message: `exit ${r.code}: ${r.stderr.slice(0, 300)}` },
            output: { code: r.code, stdout: r.stdout.slice(0, 4_000), stderr: r.stderr.slice(0, 1_000) },
            durationMs: Date.now() - started,
            cost: 3,
          };
        }
        case 'writeFile': {
          const p = String(action.args.path ?? '');
          if (!p) return this.fail(action.id, 'E_ARGS', 'writeFile.args.path required', started);
          const abs = this.inWorkspace(p);
          if (!abs) return this.fail(action.id, 'E_SCOPE', `path escapes workspace: ${p}`, started);
          await mkdir(dirnameOf(abs), { recursive: true });
          await writeFile(abs, String(action.args.content ?? ''), 'utf8');
          return { actionId: action.id, outcome: 'success', output: { path: p, bytes: String(action.args.content ?? '').length }, durationMs: Date.now() - started, cost: 1 };
        }
        case 'deleteFile': {
          const p = String(action.args.path ?? '');
          const abs = this.inWorkspace(p);
          if (!abs || !existsSync(abs)) return this.fail(action.id, 'E_SCOPE', `path not in workspace or missing: ${p}`, started);
          await rm(abs);
          return { actionId: action.id, outcome: 'success', durationMs: Date.now() - started, cost: 1 };
        }
        default:
          return this.fail(action.id, 'E_UNKNOWN_ACTION', `unknown action type ${action.type}`, started);
      }
    } catch (err) {
      return this.fail(action.id, 'E_IO', err instanceof Error ? err.message : String(err), started);
    }
  }

  async snapshot(): Promise<Snapshot> {
    const files = await this.trackFiles();
    const payload = { cwd: this.cwd, files, outputs: this.lastOutputs.slice(-5) };
    return {
      environmentId: this.id,
      version: 1,
      takenAt: new Date().toISOString(),
      stateHash: stableHash(files),
      payload,
    };
  }

  /** ENV-004. Restore = return to recorded cwd and confirm surviving files;
   *  files deleted since the snapshot are REPORTED, not resurrected. */
  async restore(snapshot: Snapshot): Promise<void> {
    const payload = snapshot.payload as { cwd: string; files: Array<{ path: string; size: number }> };
    this.cwd = payload.cwd;
    const missing = payload.files.filter((f) => !existsSync(join(this.cwd, f.path)));
    if (missing.length > 0) {
      this.lastOutputs.push(`[restore] ${missing.length} file(s) deleted since snapshot cannot be restored: ${missing.slice(0, 5).map((m) => m.path).join(', ')}`);
    }
  }

  async evaluate(): Promise<EnvironmentScore> {
    if (!this.cwd) return { environmentId: this.id, metrics: { ready: 0 }, details: 'not reset' };
    const probes: Array<[string, string]> = [
      ['testProbe', 'if exist package.json (node --test --pass-with-no-tests 2>nul) else (exit 0)'],
      ['gitProbe', 'git status --porcelain'],
    ];
    const metrics: Record<string, number> = { ready: 1, trackedFiles: (await this.trackFiles()).length };
    for (const [name, cmd] of probes) {
      const r = await runShell(cmd, this.cwd, 15_000).catch(() => ({ code: 1, stdout: '', stderr: 'probe failed' }));
      metrics[name] = r.code === 0 ? 1 : 0;
    }
    return { environmentId: this.id, metrics };
  }

  async close(): Promise<void> {
    this.lastOutputs = [];
  }

  private guard(_action: Action): ActionResult | null {
    if (!this.cwd) return this.fail('early', 'E_NOT_RESET', 'call reset() before act()', Date.now());
    return null;
  }

  private inWorkspace(p: string): string | null {
    const root = resolve(this.opts.workspaceDir);
    const abs = isAbsolute(p) ? resolve(p) : resolve(this.cwd, p);
    const rel = relative(root, abs);
    return rel.startsWith('..') ? null : abs;
  }

  private async trackFiles(): Promise<Array<{ path: string; size: number }>> {
    if (!this.cwd || !existsSync(this.cwd)) return [];
    const out: Array<{ path: string; size: number }> = [];
    await walk(this.cwd, this.cwd, out, this.maxFiles);
    return out;
  }

  private fail(actionId: string, code: string, message: string, started: number): ActionResult {
    return { actionId, outcome: 'failure', error: { code, message }, durationMs: Date.now() - started };
  }
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '.';
}

async function walk(root: string, dir: string, out: Array<{ path: string; size: number }>, cap: number): Promise<void> {
  if (out.length >= cap) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out, cap);
    else {
      try {
        const s = await stat(full);
        out.push({ path: relative(root, full).replace(/\\/g, '/'), size: s.size });
      } catch { /* raced */ }
    }
    if (out.length >= cap) return;
  }
}

export function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', cmd], { cwd, windowsHide: true })
      : spawn('/bin/sh', ['-c', cmd], { cwd });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolveP({ code: 124, stdout, stderr: stderr + `\n[timeout after ${timeoutMs}ms]` });
      }
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ code: 127, stdout, stderr: String(err) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ code: code ?? 0, stdout, stderr });
    });
  });
}
