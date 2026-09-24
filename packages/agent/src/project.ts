/**
 * @hmharness/agent - project runtime (V2 M8, ADR-0002)
 * The Project entity from the V2 blueprint: one record per project workspace
 * binding state machine, checkpoints, decisions, run continuation, releases.
 *
 * Safety posture (the whole design bends around it):
 *  - Checkpoints are git PLUMBING snapshots: a temp index (GIT_INDEX_FILE
 *    inside the project dir) + read-tree/add/write-tree. Objects land in the
 *    repo's .git/objects; the user's index, refs, branches and worktree are
 *    never touched - checkpointing does not require the user to commit.
 *  - Restore MATERIALIZES a checkpoint into a fresh sandbox copy (git archive
 *    + tar). Recovery never mutates the user's tree; there is no code path
 *    here that resets anything in the real workspace.
 *  - Run continuation rides the 0.8.2 rollout append semantics: attachRun
 *    remembers the session id; the caller resumes with loadTranscript +
 *    runAgentTask({ sessionId }).
 */
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile as execCb } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sandbox, type SandboxSession } from '@hmharness/sandbox';

export type ProjectState = 'created' | 'active' | 'paused' | 'completed' | 'archived';

/** blueprint lifecycle: created→active→paused(=resumable)→completed→archived */
const TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  created: ['active'],
  active: ['paused', 'completed'],
  paused: ['active', 'completed'],
  completed: ['archived'],
  archived: [],
};

export interface CheckpointRef {
  id: string;
  label?: string;
  /** git tree sha, or 'copy:<relative dir>' for non-git workspaces */
  tree: string;
  time: string;
  files: number;
}

export interface DecisionEntry {
  time: string;
  kind: 'checkpoint' | 'restore' | 'interrupt' | 'decision' | 'state' | 'attach-run' | 'release';
  summary: string;
  ref?: string;
}

export interface ProjectRecord {
  projectId: string;
  name?: string;
  workspace: string;
  state: ProjectState;
  createdAt: string;
  updatedAt: string;
  checkpoints: CheckpointRef[];
  tasks: string[];
  decisions: DecisionEntry[];
  memory: string;
  skills: string[];
  runs: Array<{ sessionId: string; time: string }>;
  benchmarks: string[];
  releases: Array<{ version: string; checkpointId?: string; time: string; notes?: string }>;
}

/* ---------------- git plumbing (checkpoint side) ---------------- */

const GIT_CANDIDATES = ['git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'];
let gitBin: string | undefined;

function run(exe: string, args: string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number; launchFailed: boolean }> {
  return new Promise((res) => {
    execCb(exe, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: opts.timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) { res({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0, launchFailed: false }); return; }
      const e = err as NodeJS.ErrnoException & { code?: number | string };
      // ENOENT-style launch failure (string code) -> try next candidate;
      // a real non-zero exit (numeric code) is a git answer, not a failure to launch
      res({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: typeof e.code === 'number' ? e.code : -1, launchFailed: typeof e.code !== 'number' });
    });
  });
}

async function git(args: string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }> {
  const candidates = [...(gitBin ? [gitBin] : []), ...GIT_CANDIDATES];
  let last = { stdout: '', stderr: 'git not found', code: -1, launchFailed: true };
  for (const exe of candidates) {
    last = await run(exe, args, opts);
    if (!last.launchFailed) { gitBin = exe; return last; }
  }
  throw new Error(last.stderr || 'git not found');
}

async function isGitRepo(workspace: string): Promise<boolean> {
  try {
    const r = await git(['rev-parse', '--is-inside-work-tree'], { cwd: workspace });
    return r.code === 0 && r.stdout.trim() === 'true';
  } catch { return false; }
}

/* ---------------- persistence ---------------- */

function projRoot(home: string): string { return join(home, 'projects'); }
function projDir(home: string, id: string): string { return join(projRoot(home), id); }
function projFile(home: string, id: string): string { return join(projDir(home, id), 'project.json'); }

async function save(home: string, rec: ProjectRecord): Promise<void> {
  rec.updatedAt = new Date().toISOString();
  await mkdir(projDir(home, rec.projectId), { recursive: true });
  await writeFile(projFile(home, rec.projectId), JSON.stringify(rec, null, 2) + '\n', 'utf8');
}

async function decide(home: string, rec: ProjectRecord, kind: DecisionEntry['kind'], summary: string, ref?: string): Promise<void> {
  const entry: DecisionEntry = { time: new Date().toISOString(), kind, summary, ...(ref ? { ref } : {}) };
  rec.decisions.push(entry);
  try { await appendFile(join(projDir(home, rec.projectId), 'decisions.jsonl'), JSON.stringify(entry) + '\n', 'utf8'); } catch { /* mirror is best-effort */ }
}

/* ---------------- lifecycle ---------------- */

export function newProjectId(): string {
  return `proj_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function createProject(home: string, workspace: string, name?: string): Promise<ProjectRecord> {
  const rec: ProjectRecord = {
    projectId: newProjectId(),
    name,
    workspace: resolve(workspace),
    state: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    checkpoints: [],
    tasks: [],
    decisions: [],
    memory: resolve(workspace),
    skills: [],
    runs: [],
    benchmarks: [],
    releases: [],
  };
  await decide(home, rec, 'state', `project created for ${rec.workspace}`);
  await save(home, rec);
  return rec;
}

export async function listProjects(home: string): Promise<ProjectRecord[]> {
  let ids: string[] = [];
  try { ids = (await readdir(projRoot(home))).filter((d) => d.startsWith('proj_')); } catch { return []; }
  const out: ProjectRecord[] = [];
  for (const id of ids) {
    try { out.push(JSON.parse(await readFile(projFile(home, id), 'utf8')) as ProjectRecord); } catch { /* skip torn */ }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function loadProject(home: string, projectId: string): Promise<ProjectRecord | null> {
  try { return JSON.parse(await readFile(projFile(home, projectId), 'utf8')) as ProjectRecord; } catch { return null; }
}

function samePath(a: string, b: string): boolean {
  return resolve(a).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') === resolve(b).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/** Find the newest project bound to this workspace (null if none). */
export async function findProject(home: string, workspace: string): Promise<ProjectRecord | null> {
  const all = await listProjects(home);
  return all.find((p) => samePath(p.workspace, workspace) && p.state !== 'archived') ?? null;
}

/** find-or-create + auto-activate (the default entry point for CLIs). */
export async function projectFor(home: string, workspace: string, name?: string): Promise<ProjectRecord> {
  const found = await findProject(home, workspace);
  if (found) {
    if (found.state === 'created') return transitionProject(home, found, 'active');
    return found;
  }
  const rec = await createProject(home, workspace, name);
  return transitionProject(home, rec, 'active');
}

export async function transitionProject(home: string, rec: ProjectRecord, next: ProjectState): Promise<ProjectRecord> {
  const allowed = TRANSITIONS[rec.state] ?? [];
  if (!allowed.includes(next)) throw new Error(`illegal transition ${rec.state} -> ${next} (allowed: ${allowed.join(', ') || 'none'})`);
  const from = rec.state;
  rec.state = next;
  await decide(home, rec, 'state', `${from} -> ${next}`);
  await save(home, rec);
  return rec;
}

/* ---------------- checkpoints ---------------- */

const COPY_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.hvigor', '.idea']);

/** Byte-exact snapshot via git plumbing (user index/refs/worktree untouched);
 *  directory-copy fallback for non-git workspaces. */
export async function checkpointProject(home: string, rec: ProjectRecord, label?: string): Promise<CheckpointRef> {
  if (rec.state === 'archived') throw new Error('archived projects cannot take checkpoints');
  let ref: CheckpointRef;
  if (await isGitRepo(rec.workspace)) {
    const indexFile = join(projDir(home, rec.projectId), `index-${Date.now()}`);
    await mkdir(projDir(home, rec.projectId), { recursive: true });
    const env = { GIT_INDEX_FILE: indexFile };
    // seed the temp index from HEAD (no commits yet -> start empty), then
    // overlay the whole worktree; write-tree freezes it as an object
    await git(['read-tree', 'HEAD'], { cwd: rec.workspace, env, timeoutMs: 30_000 });
    await git(['add', '-A', '--', '.'], { cwd: rec.workspace, env, timeoutMs: 120_000 });
    const tree = (await git(['write-tree'], { cwd: rec.workspace, env })).stdout.trim();
    // workspace may sit inside a subdirectory of the repo - snapshot THE
    // SUBTREE (what the project actually owns), not the whole monorepo
    const prefix = (await git(['rev-parse', '--show-prefix'], { cwd: rec.workspace })).stdout.trim().replace(/\\/g, '/');
    const subTree = prefix ? (await git(['rev-parse', `${tree}:${prefix}`], { cwd: rec.workspace })).stdout.trim() : tree;
    if (!/^[0-9a-f]{40}$/.test(subTree)) throw new Error(`checkpoint subtree resolve failed (prefix "${prefix}")`);
    const files = (await git(['ls-tree', '-r', '--name-only', subTree], { cwd: rec.workspace })).stdout.split('\n').filter(Boolean).length;
    await rm(indexFile, { force: true });
    ref = { id: subTree.slice(0, 10), label, tree: subTree, time: new Date().toISOString(), files };
  } else {
    const rel = `artifacts/cp-${Date.now().toString(36)}`;
    const dest = join(projDir(home, rec.projectId), rel);
    // the copy fallback cannot handle the workspace containing the destination
    // (workspace == home in degenerate setups) - say so plainly instead of
    // letting cp throw EINVAL halfway through
    const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
    if (norm(dest).startsWith(norm(rec.workspace) + '\\') || norm(dest).startsWith(norm(rec.workspace) + '/')) {
      throw new Error(`checkpoint copy fallback requires the project workspace (${rec.workspace}) to be outside HMH_HOME (${home})`);
    }
    await mkdir(dest, { recursive: true });
    await cp(rec.workspace, dest, { recursive: true, filter: (src) => !COPY_SKIP.has(src.split(/[\\/]/).pop() ?? '') });
    let files = 0;
    const count = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) await count(join(d, e.name)); else files++;
      }
    };
    await count(dest);
    ref = { id: `cp_${rel.slice(-8)}`, label, tree: `copy:${rel}`, time: new Date().toISOString(), files };
  }
  rec.checkpoints.push(ref);
  await decide(home, rec, 'checkpoint', `checkpoint ${ref.id}${label ? ` (${label})` : ''} - ${ref.files} files`, ref.tree);
  await save(home, rec);
  return ref;
}

/** Materialize a checkpoint into a fresh sandbox copy for inspection or a
 *  recovery run. The user's workspace is never touched. */
export async function restoreCheckpoint(home: string, rec: ProjectRecord, checkpointId: string): Promise<SandboxSession> {
  const cpRef = rec.checkpoints.find((c) => c.id === checkpointId || c.tree === checkpointId);
  if (!cpRef) throw new Error(`no checkpoint ${checkpointId} in project ${rec.projectId}`);
  const dir = await mkdtemp(join(tmpdir(), 'hmh-proj-restore-'));
  const session = await sandbox.create({ dir });
  if (cpRef.tree.startsWith('copy:')) {
    await cp(join(projDir(home, rec.projectId), cpRef.tree.slice(5)), dir, { recursive: true });
  } else {
    const tarFile = join(dir, '..', `cp-${Date.now()}.tar`);
    await git(['archive', '--format=tar', `--output=${tarFile}`, cpRef.tree], { cwd: rec.workspace, timeoutMs: 120_000 });
    await new Promise<void>((res, rej) => {
      execCb('tar', ['-xf', tarFile, '-C', dir], { timeout: 120_000, windowsHide: true }, (err) => err ? rej(err) : res());
    });
    await rm(tarFile, { force: true });
  }
  await decide(home, rec, 'restore', `checkpoint ${cpRef.id} materialized to ${dir} (sandbox copy)`, cpRef.tree);
  await save(home, rec);
  return session;
}

/* ---------------- run continuation / interrupt / releases ---------------- */

/** Remember the rollout a project conversation lives in (0.8.2 append semantics). */
export async function attachRun(home: string, rec: ProjectRecord, sessionId: string): Promise<void> {
  rec.runs.push({ sessionId, time: new Date().toISOString() });
  await decide(home, rec, 'attach-run', `run ${sessionId}`);
  await save(home, rec);
}

/** Recovery bundle: what a resume needs - last rollout + last checkpoint. */
export async function resumeBundle(home: string, rec: ProjectRecord): Promise<{
  project: ProjectRecord;
  lastRun: string | null;
  lastCheckpoint: CheckpointRef | null;
}> {
  return {
    project: rec,
    lastRun: rec.runs.length > 0 ? rec.runs[rec.runs.length - 1].sessionId : null,
    lastCheckpoint: rec.checkpoints.length > 0 ? rec.checkpoints[rec.checkpoints.length - 1] : null,
  };
}

/** Interrupt: record the event and pause (paused = resumable per blueprint).
 *  The actual abort stays with the caller's AbortSignal. */
export async function interruptProject(home: string, rec: ProjectRecord, reason?: string): Promise<ProjectRecord> {
  await decide(home, rec, 'interrupt', `interrupted${reason ? `: ${reason}` : ''}`);
  await save(home, rec);
  if (rec.state === 'active') return transitionProject(home, rec, 'paused');
  return rec;
}

export async function releaseProject(home: string, rec: ProjectRecord, version: string, notes?: string): Promise<void> {
  rec.releases.push({ version, checkpointId: rec.checkpoints.length > 0 ? rec.checkpoints[rec.checkpoints.length - 1].id : undefined, time: new Date().toISOString(), notes });
  await decide(home, rec, 'release', `release ${version}`);
  await save(home, rec);
}
