/**
 * @hmharness/sandbox - isolated workspace runtime (V2 blueprint M3).
 *
 * The ownership split (ADR-0001, after the OpenAI Agents SDK boundary):
 * the RUNTIME owns agent turns/approvals/tracing; the SANDBOX owns the
 * workspace, its processes and its state. Snapshots are git commits inside
 * the sandbox dir - restore is a hard reset + clean, so a rolled-back
 * sandbox is byte-identical to the snapshot (tests assert exactly that).
 * Everything executes execFile-style (no shell strings, shellgate doctrine).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execCb = promisify(execFile);

/** Permission tiers - the Codex/OpenAI three-tier model, plus the extension
 *  tiers the V2 blueprint names for device/network/desktop capabilities. */
export type SandboxTier = 'READ_ONLY' | 'WORKSPACE_WRITE' | 'FULL_ACCESS';

export interface SandboxSpec {
  /** Existing empty-or-new directory; omitted -> a fresh temp dir. */
  dir?: string;
  tier?: SandboxTier;
}

export interface SandboxSession {
  id: string;
  dir: string;
  tier: SandboxTier;
}

export interface ExecSpec {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SnapshotRef {
  id: string;
  /** git commit sha */
  sha: string;
  label?: string;
}

export interface WorkspaceDiff {
  /** unified diff of uncommitted changes ('' when clean) */
  patch: string;
  files: string[];
}

export class SandboxDenied extends Error {
  constructor(action: string, tier: SandboxTier) {
    super(`sandbox: ${action} denied at tier ${tier}`);
  }
}

/* git binary resolution: .cmd shims can't execFile-spawn on modern Node */
const GIT_CANDIDATES = ['git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'];
let gitBin: string | undefined;
async function git(args: string[], opts: { cwd: string; timeoutMs?: number; ok?: number[] }): Promise<{ stdout: string; stderr: string }> {
  let lastErr: unknown;
  for (const exe of [gitBin, ...GIT_CANDIDATES].filter(Boolean) as string[]) {
    try {
      const r = await execCb(exe, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      gitBin = exe;
      return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      if (typeof e.code === 'number' && (opts.ok ?? [0]).includes(e.code)) {
        gitBin = exe;
        return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
      }
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('git not found');
}

let seq = 0;

export const sandbox = {
  /** Create an isolated workspace with a fresh git repo (snapshots need it). */
  async create(spec: SandboxSpec = {}): Promise<SandboxSession> {
    const dir = spec.dir ?? await mkdtemp(join(tmpdir(), 'hmh-sbx-'));
    const session: SandboxSession = { id: `sbx_${Date.now().toString(36)}_${++seq}`, dir, tier: spec.tier ?? 'WORKSPACE_WRITE' };
    await git(['init', '-q'], { cwd: dir });
    await git(['config', 'user.email', 'sandbox@hmharness.local'], { cwd: dir });
    await git(['config', 'user.name', 'hmh-sandbox'], { cwd: dir });
    return session;
  },

  /** Run a command INSIDE the sandbox (execFile, no shell, cwd = sandbox). */
  async exec(s: SandboxSession, spec: ExecSpec): Promise<ExecResult> {
    if (s.tier === 'READ_ONLY') throw new SandboxDenied('exec', s.tier);
    try {
      const r = await execCb(spec.command, spec.args ?? [], { cwd: s.dir, timeout: spec.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      return { exitCode: 0, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
      return { exitCode: typeof e.code === 'number' ? e.code : -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') + (e.killed ? ' (timed out)' : '') };
    }
  },

  async read(s: SandboxSession, path: string): Promise<string> {
    return readFile(join(s.dir, path), 'utf8');
  },

  async write(s: SandboxSession, path: string, data: string): Promise<void> {
    if (s.tier === 'READ_ONLY') throw new SandboxDenied('write', s.tier);
    await writeFile(join(s.dir, path), data, 'utf8');
  },

  async list(s: SandboxSession): Promise<string[]> {
    return readdir(s.dir);
  },

  /** Snapshot = commit everything (incl. untracked) - restore is exact. */
  async snapshot(s: SandboxSession, label?: string): Promise<SnapshotRef> {
    await git(['add', '-A'], { cwd: s.dir });
    // an empty repo with nothing staged still needs a root commit: --allow-empty
    const r = await git(['commit', '-q', '--allow-empty', '-m', `snapshot${label ? ': ' + label : ''}`], { cwd: s.dir });
    void r;
    const sha = (await git(['rev-parse', 'HEAD'], { cwd: s.dir })).stdout.trim();
    return { id: sha.slice(0, 10), sha, label };
  },

  /** Restore = hard reset + clean: the sandbox becomes byte-identical to the snapshot. */
  async restore(s: SandboxSession, ref: SnapshotRef): Promise<void> {
    if (s.tier === 'READ_ONLY') throw new SandboxDenied('restore', s.tier);
    await git(['reset', '--hard', ref.sha], { cwd: s.dir }); // safe: inside the sandbox repo only
    await git(['clean', '-fdq'], { cwd: s.dir });
  },

  /** Unified diff of uncommitted changes (workspace drift since last snapshot). */
  async diff(s: SandboxSession): Promise<WorkspaceDiff> {
    await git(['add', '-A'], { cwd: s.dir });
    const r = await git(['diff', '--cached', '--stat', '--name-only'], { cwd: s.dir, ok: [0, 1] });
    const files = r.stdout.trim().split('\n').filter(Boolean);
    if (files.length === 0) return { patch: '', files: [] };
    const full = await git(['diff', '--cached'], { cwd: s.dir, ok: [0, 1] });
    return { patch: full.stdout, files };
  },

  async destroy(s: SandboxSession): Promise<void> {
    await rm(s.dir, { recursive: true, force: true });
  },
};
