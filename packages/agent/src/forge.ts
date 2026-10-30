/**
 * @hmharness/agent - git forge tools (GitHub / AtomGit)
 *
 * First-class repository operations on the user's forges, driven by the
 * platforms' own first-party CLIs: gh (GitHub) and ag (AtomGit — a
 * gh-shaped command surface). Zero new dependencies: shell call + JSON
 * parse. Credentials NEVER enter hmharness state — they stay in gh's
 * keyring/hosts.yml and ag's own config storage; we only read `auth
 * status` text to report the login user.
 *
 * Wire differences absorbed here (builders are pure + exported so tests
 * assert exact argument assembly without a forge): gh `--json` takes a
 * field list, ag `--json` is a boolean dump; gh selects repos with
 * `-R owner/repo`, ag takes owner/repo positionally; gh release notes
 * are `--title/--notes`, ag's are `--name/--body`; ag numbers arrive as
 * strings. All commands run through exec() with manual quoting because
 * ag installs as `ag.cmd` (npm global) — execFile cannot spawn .cmd on
 * Windows (ENOENT/EINVAL since the 2024 security patch), and exec()
 * resolves PATH exactly like the user's shell, fake-CLI test seams
 * included.
 */
import { exec } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Tool, ToolResult } from '@hmharness/kernel';

const execCb = promisify(exec);

export type ForgeHost = 'github' | 'atomgit';

export const FORGE_BINS: Record<ForgeHost, string> = { github: 'gh', atomgit: 'ag' };

const PAGE_SIZE = 30;
const MAX_PAGE = 10;
const RUN_TIMEOUT_MS = 60_000;

export function installHint(host: ForgeHost): string {
  return host === 'github'
    ? 'gh (GitHub CLI) is not installed. Install it first: `winget install GitHub.cli` on Windows, `brew install gh` on macOS — https://cli.github.com'
    : 'ag (AtomGit CLI) is not installed. Install it first: `npm install -g @hust-open-atom-club/atomgit-cli` — https://atomgit.com/hust-open-atom-club/atomgit-cli';
}

export function loginHint(host: ForgeHost): string {
  const bin = FORGE_BINS[host];
  return `Not logged in to ${host}. Run the forge_login tool with host:"${host}" (it shows the device code/URL), or manually: \`${bin} auth login\``;
}

/** Shell-quote one argument. Windows: cmd.exe rules (wrap in "...", double
 *  embedded quotes; a literal % inside quotes still expands — accepted as a
 *  cmd.exe limitation, forge inputs rarely contain %). POSIX: single quotes
 *  with the '\'' escape. (Pure, testable.) */
export function quoteArg(s: string, platform: string = process.platform): string {
  if (s === '') return '""';
  if (platform === 'win32') {
    if (!/[\s"&|<>^()%!]/.test(s)) return s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  if (!/[\s'"$`\\&|;<>()*?\[\]#!]/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Parse `auth status` text for BOTH CLIs' phrasings:
 *  gh: "✓ Logged in to github.com account swsgbl (keyring)"
 *  ag: "✓ Logged in to atomgit.com as hongfu" */
export function parseAuthStatus(text: string): { loggedIn: boolean; user?: string } {
  if (!/Logged in to/.test(text)) return { loggedIn: false };
  const m = /Logged in to \S+ (?:account|as) (\S+?)[\s(\r]/.exec(text) ?? /Logged in to \S+ (?:account|as) (\S+)/.exec(text);
  return { loggedIn: true, user: m?.[1] };
}

function str(v: unknown): string { return v === undefined || v === null ? '' : String(v); }

// ---------------- pure command builders ----------------

export function repoListArgs(host: ForgeHost, owner?: string, page = 1): string[] {
  // neither CLI supports --page/--offset: page N fetches N*30 rows and the
  // runner slices the window out (honest paging for N<=10 without --paginate)
  const p = pageOf(page);
  return [
    'repo', 'list',
    ...(owner ? [owner] : []),
    '--limit', String(p * PAGE_SIZE),
    ...(host === 'github' ? ['--json', 'name,visibility,updatedAt,pushedAt'] : ['--json']),
  ];
}

function pageOf(page: number): number {
  const p = Math.floor(Number(page) || 1);
  return Math.max(1, Math.min(p, MAX_PAGE));
}

export function repoCreateArgs(host: ForgeHost, name: string, visibility: 'public' | 'private', description?: string): string[] {
  const desc = description ? [host === 'github' ? '--description' : '-d', description] : [];
  return ['repo', 'create', name, visibility === 'private' ? '--private' : '--public', ...desc];
}

export function prListArgs(host: ForgeHost, repo: string, state = 'open'): string[] {
  const s = ['open', 'closed', 'all'].includes(state) ? state : 'open';
  return host === 'github'
    ? ['pr', 'list', '-R', repo, '--state', s, '--limit', '30', '--json', 'number,title,state,author,headRefName,url']
    : ['pr', 'list', repo, '--state', s, '--limit', '30', '--json'];
}

export function prCreateArgs(host: ForgeHost, repo: string, head: string, base: string, title: string, body?: string): string[] {
  const b = body ? ['--body', body] : [];
  const sel = host === 'github' ? ['-R', repo] : [repo];
  return ['pr', 'create', ...sel, '--head', head, '--base', base, '--title', title, ...b];
}

export function prMergeArgs(host: ForgeHost, repo: string, num: string, method: 'merge' | 'squash' | 'rebase' = 'merge'): string[] {
  if (host === 'github') {
    const flag = method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge';
    return ['pr', 'merge', num, '-R', repo, flag];
  }
  // ag merges with the default method unless a flag says otherwise
  const flag = method === 'squash' ? ['--squash'] : method === 'rebase' ? ['--rebase'] : [];
  return ['pr', 'merge', repo, num, ...flag];
}

export function prChecksArgs(host: ForgeHost, repo: string, num: string): string[] {
  return host === 'github'
    ? ['pr', 'checks', num, '-R', repo, '--json', 'name,state']
    : ['pr', 'checks', repo, num];
}

export function issueListArgs(host: ForgeHost, repo: string, state = 'open'): string[] {
  const s = ['open', 'closed', 'all'].includes(state) ? state : 'open';
  return host === 'github'
    ? ['issue', 'list', '-R', repo, '--state', s, '--limit', '30', '--json', 'number,title,state,author,url']
    : ['issue', 'list', repo, '--state', s, '--limit', '30', '--json'];
}

export function issueCreateArgs(host: ForgeHost, repo: string, title: string, body?: string): string[] {
  const b = body ? ['--body', body] : [];
  const sel = host === 'github' ? ['-R', repo] : [repo];
  return ['issue', 'create', ...sel, '--title', title, ...b];
}

export function releaseCreateArgs(host: ForgeHost, repo: string, tag: string, name: string, body: string, target?: string): string[] {
  const t = target ? ['--target', target] : [];
  return host === 'github'
    ? ['release', 'create', tag, '-R', repo, '--title', name, '--notes', body, ...t]
    : ['release', 'create', repo, tag, '--name', name, '--body', body, ...t]; // AtomGit API requires a non-empty body
}

export function releaseUploadArgs(host: ForgeHost, repo: string, tag: string, file: string): string[] {
  return host === 'github'
    ? ['release', 'upload', tag, file, '-R', repo]
    : ['release', 'upload', repo, tag, file];
}

// ---------------- detection + execution ----------------

export interface ForgeHostStatus {
  host: ForgeHost;
  bin: string;
  installed: boolean;
  loggedIn: boolean;
  user?: string;
}

/** where/which probe — goes through the shell so PATH seams (real or fake) apply. */
export async function forgeBinInstalled(host: ForgeHost): Promise<boolean> {
  const bin = FORGE_BINS[host];
  const probe = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
  try { await execCb(probe, { timeout: 10_000, windowsHide: true }); return true; } catch { return false; }
}

export async function forgeDetectHost(host: ForgeHost): Promise<ForgeHostStatus> {
  const bin = FORGE_BINS[host];
  if (!(await forgeBinInstalled(host))) return { host, bin, installed: false, loggedIn: false };
  try {
    const { stdout, stderr } = await execCb(`${bin} auth status`, { timeout: 15_000, windowsHide: true });
    const p = parseAuthStatus(stdout + '\n' + stderr);
    return { host, bin, installed: true, ...p };
  } catch (err) {
    // both CLIs exit non-zero when logged out but still print their status
    const e = err as { stdout?: string; stderr?: string };
    const p = parseAuthStatus([e.stdout, e.stderr].filter(Boolean).join('\n'));
    return { host, bin, installed: true, ...p };
  }
}

/** Detect both forges in parallel (forge_status / guidance basis). */
export async function forgeDetect(): Promise<ForgeHostStatus[]> {
  return Promise.all((['github', 'atomgit'] as ForgeHost[]).map(forgeDetectHost));
}

/** Run one forge CLI command (quoted, 60s timeout, agent cwd). Installed-check
 *  first so a missing CLI yields the install hint, not cmd.exe mojibake.
 *  (exec instead of execFile is deliberate: ag installs as ag.cmd, which
 *  execFile cannot spawn on Windows since the 2024 security patch; quoteArg
 *  hardens every shell metacharacter, so the injection surface is strictly
 *  smaller than run_command's free-form line.) */
export async function forgeRun(host: ForgeHost, args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<{ ok: boolean; output: string }> {
  const bin = FORGE_BINS[host];
  if (!(await forgeBinInstalled(host))) return { ok: false, output: installHint(host) };
  const line = [bin, ...args.map((a) => quoteArg(String(a)))].join(' ');
  try {
    const { stdout, stderr } = await execCb(line, {
      cwd: opts.cwd, timeout: opts.timeoutMs ?? RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    });
    const out = (stdout || '').trim() + (stderr && stderr.trim() ? `\n[stderr]\n${stderr.trim()}` : '');
    return { ok: true, output: out.trim() || '(no output)' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (e.killed) return { ok: false, output: `${bin} command timed out after ${opts.timeoutMs ?? RUN_TIMEOUT_MS}ms — narrow it (add --limit, a smaller page) and retry.` };
    const out = [e.stdout, e.stderr, e.message].filter(Boolean).map((s) => String(s).trim()).filter(Boolean).join('\n');
    return { ok: false, output: out.slice(0, 20_000) || `${bin} failed (no output)` };
  }
}

/** Guard shared by every forge tool except status/login/raw: valid host,
 *  CLI installed, logged in — or the honest, actionable error. */
async function guard(host: ForgeHost): Promise<ToolResult | null> {
  const st = await forgeDetectHost(host);
  if (!st.installed) return { output: installHint(host), isError: true };
  if (!st.loggedIn) return { output: loginHint(host), isError: true };
  return null;
}

function hostOf(args: Record<string, unknown>): { host?: ForgeHost; err?: ToolResult } {
  const h = String(args.host ?? '');
  if (h === 'github' || h === 'atomgit') return { host: h };
  return { err: { output: `host must be 'github' or 'atomgit' (got '${h}')`, isError: true } };
}

// ---------------- renderers (forge JSON -> compact lines) ----------------

/** Tolerant JSON-array extraction: finds the first [ or { (both CLIs may
 *  print a banner line before the payload), wraps single objects. */
export function parseJsonOut(text: string): unknown[] | null {
  const idxs = ['[', '{'].map((c) => text.indexOf(c)).filter((i) => i >= 0);
  if (!idxs.length) return null;
  try {
    const v = JSON.parse(text.slice(Math.min(...idxs)));
    return Array.isArray(v) ? v : [v];
  } catch { return null; }
}

export function renderRepos(rows: unknown[]): string {
  const lines = rows.map((r) => {
    const o = r as Record<string, unknown>;
    const name = str(o.name) || str(o.fullName) || '?';
    const vis = (str(o.visibility) || (o.isPrivate ? 'private' : '')).toLowerCase();
    // AtomGit's repo payload has no pushedAt — say so instead of inventing one
    const pushed = o.pushedAt ? str(o.pushedAt) : 'n/a (host does not report)';
    return `${name} [${vis.includes('priv') ? 'private' : 'public'}] updated=${str(o.updatedAt) || '?'} pushed=${pushed}`;
  });
  return lines.length ? lines.join('\n') : '(no repositories found)';
}

export function renderPrs(rows: unknown[]): string {
  const lines = rows.map((r) => {
    const o = r as Record<string, unknown>;
    const author = typeof o.author === 'object' && o.author ? str((o.author as Record<string, unknown>).login) : str(o.author);
    const head = str(o.headRefName) || str(o.head);
    return `#${str(o.number)} [${str(o.state) || '?'}] ${str(o.title)} — ${author || '?'}${head ? ` (${head})` : ''} ${str(o.url)}`.trimEnd();
  });
  return lines.length ? lines.join('\n') : '(no pull requests found)';
}

export function renderIssues(rows: unknown[]): string {
  const lines = rows.map((r) => {
    const o = r as Record<string, unknown>;
    const author = typeof o.author === 'object' && o.author ? str((o.author as Record<string, unknown>).login) : str(o.author);
    return `#${str(o.number)} [${str(o.state) || '?'}] ${str(o.title)} — ${author || '?'} ${str(o.url)}`.trimEnd();
  });
  return lines.length ? lines.join('\n') : '(no issues found)';
}

// ---------------- tools ----------------

export const forgeStatusTool: Tool = {
  name: 'forge_status',
  description: 'Show GitHub (gh) and AtomGit (ag) CLI install + login status at a glance. Call this FIRST for any repository task on a forge.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    const rows = await forgeDetect();
    const lines = rows.map((s) => {
      if (!s.installed) return `${s.host}: NOT installed — ${installHint(s.host)}`;
      if (!s.loggedIn) return `${s.host}: installed (${s.bin}), NOT logged in — ${loginHint(s.host)}`;
      return `${s.host}: installed (${s.bin}), logged in as ${s.user ?? '(user unknown)'}`;
    });
    return { output: lines.join('\n') };
  },
};

export const forgeRepoListTool: Tool = {
  name: 'forge_repo_list',
  description: 'List repositories on a forge — your own, or an owner/org\'s. host: github|atomgit; optional owner, page (30/page, max 10).',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: "'github' or 'atomgit'" },
      owner: { type: 'string', description: 'owner/org login (default: the logged-in account)' },
      page: { type: 'number', description: '1-based page of 30 (max 10)' },
    },
    required: ['host'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { host, err } = hostOf(args);
    if (!host || err) return err!;
    const g = await guard(host);
    if (g) return g;
    const page = pageOf(Number(args.page ?? 1));
    const r = await forgeRun(host, repoListArgs(host, args.owner ? String(args.owner) : undefined, page), { cwd: ctx.cwd });
    if (!r.ok) return { output: r.output, isError: true };
    const rows = parseJsonOut(r.output);
    if (!rows) return { output: `could not parse ${host} repo list JSON — raw output:\n${r.output.slice(0, 4_000)}`, isError: true };
    const win = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    return { output: `${host} repositories (page ${page}${args.owner ? `, owner ${args.owner}` : ''}):\n${renderRepos(win)}` };
  },
};

export const forgeRepoCreateTool: Tool = {
  name: 'forge_repo_create',
  description: 'Create a repository on a forge. host: github|atomgit; name (may be owner/name to create under an org); visibility public|private (default private); optional description.',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: "'github' or 'atomgit'" },
      name: { type: 'string', description: 'repository name (or owner/name)' },
      visibility: { type: 'string', description: "'public' or 'private' (default private)" },
      description: { type: 'string', description: 'one-line description' },
    },
    required: ['host', 'name'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { host, err } = hostOf(args);
    if (!host || err) return err!;
    const g = await guard(host);
    if (g) return g;
    const vis = String(args.visibility ?? 'private') === 'public' ? 'public' : 'private';
    const r = await forgeRun(host, repoCreateArgs(host, String(args.name ?? ''), vis, args.description ? String(args.description) : undefined), { cwd: ctx.cwd });
    return { output: `created ${vis} repo ${args.name} on ${host}:\n${r.output}`, isError: !r.ok };
  },
};

export const forgePrListTool: Tool = {
  name: 'forge_pr_list',
  description: 'List pull requests of owner/repo on a forge. host: github|atomgit; repo owner/repo; state open|closed|all (default open).',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: "'github' or 'atomgit'" },
      repo: { type: 'string', description: 'owner/repo' },
      state: { type: 'string', description: 'open | closed | all (default open)' },
    },
    required: ['host', 'repo'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { host, err } = hostOf(args);
    if (!host || err) return err!;
    const g = await guard(host);
    if (g) return g;
    const r = await forgeRun(host, prListArgs(host, String(args.repo ?? ''), String(args.state ?? 'open')), { cwd: ctx.cwd });
    if (!r.ok) return { output: r.output, isError: true };
    const rows = parseJsonOut(r.output);
    if (!rows) return { output: `could not parse ${host} pr list JSON — raw output:\n${r.output.slice(0, 4_000)}`, isError: true };
    return { output: `${host} pull requests (${args.repo}, ${String(args.state ?? 'open')}):\n${renderPrs(rows)}` };
  },
};

export const forgePrCreateTool: Tool = {
  name: 'forge_pr_create',
  description: 'Create a pull request. host: github|atomgit; repo owner/repo; head branch; base branch; title; optional body. Branch must already be pushed.',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: "'github' or 'atomgit'" },
      repo: { type: 'string', description: 'owner/repo' },
      head: { type: 'string', description: 'source branch (e.g. feat/x)' },
      base: { type: 'string', description: 'target branch (e.g. main)' },
      title: { type: 'string', description: 'PR title' },
      body: { type: 'string', description: 'PR description (markdown)' },
    },
    required: ['host', 'repo', 'head', 'base', 'title'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { host, err } = hostOf(args);
    if (!host || err) return err!;
    const g = await guard(host);
    if (g) return g;
    const r = await forgeRun(host, prCreateArgs(host, String(args.repo ?? ''), String(args.head ?? ''), String(args.base ?? ''), String(args.title ?? ''), args.body ? String(args.body) : undefined), { cwd: ctx.cwd });
    return { output: `pull request created on ${host}:\n${r.output}`, isError: !r.ok };
  },
};

export const forgePrMergeTool: Tool = {
  name: 'forge_pr_merge',
  description: 'Merge a pull request. host: github|atomgit; repo owner/repo; num PR number; method merge|squash|rebase (default merge). Irreversible — confirm with the user first.',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: "'github' or 'atomgit'" },
      repo: { type: 'string', description: 'owner/repo' },
      num: { type: 'string', description: 'PR number' },
      method: { type: 'string', description: 'merge | squash | rebase (default merge)' },
    },
    required: ['host', 'repo', 'num'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { host, err } = hostOf(args);
    if (!host || err) return err!;
    const g = await guard(host);
    if (g) return g;
    const m = String(args.method ?? 'merge');
    const r = await forgeRun(host, prMergeArgs(host, String(args.repo ?? ''), String(args.num ?? ''), m === 'squash' ? 'squash' : m === 'rebase' ? 'rebase' : 'merge'), { cwd: ctx.cwd });
    return { output: r.output, isError: !r.ok };
  },
};

export const forgePrChecksTool: Tool = {
  name: 'forge_pr_checks',
  description: 'Show CI checks/status for a pull request. host: github|atomgit; repo owner/repo; num PR number. Older ag builds without `pr checks` report it honestly.',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: "'github' or 'atomgit'" },
      repo: { type: 'string', description: 'owner/repo' },
      num: { type: 'string', description: 'PR number' },
    },
    required: ['host', 'repo', 'num'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { host, err } = hostOf(args);
    if (!host || err) return err!;
    const g = await guard(host);
    if (g) return g;
    const r = await forgeRun(host, prChecksArgs(host, String(args.repo ?? ''), String(args.num ?? '')), { cwd: ctx.cwd });
    if (r.ok) {
      const rows = parseJsonOut(r.output); // gh --json name,state
      const body = rows && rows.length && typeof (rows[0] as Record<string, unknown>)?.name === 'string'
        ? rows.map((x) => { const o = x as Record<string, unknown>; return `${str(o.name)}: ${str(o.state)}`; }).join('\n')
        : r.output; // ag prints a human table — pass it through as-is
      return { output: `checks for ${host} PR #${args.num}:\n${body}` };
    }
    return {
      output: `${r.output}\n(If your ag version predates \`ag pr checks\` — added in atomgit-cli 0.7.x — the host genuinely does not expose checks here; tell the user that instead of guessing.)`,
      isError: true,
    };
  },
};

export const forgeIssueListTool: Tool = {
  name: 'forge_issue_list',
  description: 'List issues of owner/repo on a forge. host: github|atomgit; repo owner/repo; state open|closed|all (default open).',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: "'github' or 'atomgit'" },
      repo: { type: 'string', description: 'owner/repo' },
      state: { type: 'string', description: 'open | closed | all (default open)' },
    },
    required: ['host', 'repo'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { host, err } = hostOf(args);
    if (!host || err) return err!;
    const g = await guard(host);
    if (g) return g;
    const r = await forgeRun(host, issueListArgs(host, String(args.repo ?? ''), String(args.state ?? 'open')), { cwd: ctx.cwd });
    if (!r.ok) return { output: r.output, isError: true };
    const rows = parseJsonOut(r.output);
    if (!rows) return { output: `could not parse ${host} issue list JSON — raw output:\n${r.output.slice(0, 4_000)}`, isError: true };
    return { output: `${host} issues (${args.repo}, ${String(args.state ?? 'open')}):\n${renderIssues(rows)}` };
  },
};

export const forgeIssueCreateTool: Tool = {
  name: 'forge_issue_create',
  description: 'Create an issue. host: github|atomgit; repo owner/repo; title; optional body.',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: "'github' or 'atomgit'" },
      repo: { type: 'string', description: 'owner/repo' },
      title: { type: 'string', description: 'issue title' },
      body: { type: 'string', description: 'issue body (markdown)' },
    },
    required: ['host', 'repo', 'title'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { host, err } = hostOf(args);
    if (!host || err) return err!;
    const g = await guard(host);
    if (g) return g;
    const r = await forgeRun(host, issueCreateArgs(host, String(args.repo ?? ''), String(args.title ?? ''), args.body ? String(args.body) : undefined), { cwd: ctx.cwd });
    return { output: `issue created on ${host}:\n${r.output}`, isError: !r.ok };
  },
};

export const forgeReleaseCreateTool: Tool = {
  name: 'forge_release_create',
  description: 'Create a release from a tag. host: github|atomgit; repo owner/repo; tag; name (release title); body (release notes — required, AtomGit rejects empty); optional target branch/SHA when the tag does not exist yet.',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: "'github' or 'atomgit'" },
      repo: { type: 'string', description: 'owner/repo' },
      tag: { type: 'string', description: 'tag name, e.g. v1.2.0' },
      name: { type: 'string', description: 'release title' },
      body: { type: 'string', description: 'release notes (required)' },
      target: { type: 'string', description: 'target branch or commit SHA (creates the tag if absent)' },
    },
    required: ['host', 'repo', 'tag', 'name', 'body'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { host, err } = hostOf(args);
    if (!host || err) return err!;
    const g = await guard(host);
    if (g) return g;
    if (!String(args.body ?? '').trim()) return { output: 'body (release notes) is required — AtomGit rejects an empty body and gh would open an interactive editor.', isError: true };
    const r = await forgeRun(host, releaseCreateArgs(host, String(args.repo ?? ''), String(args.tag ?? ''), String(args.name ?? ''), String(args.body), args.target ? String(args.target) : undefined), { cwd: ctx.cwd });
    return { output: `release ${args.tag} created on ${host}:\n${r.output}`, isError: !r.ok };
  },
};

export const forgeReleaseUploadTool: Tool = {
  name: 'forge_release_upload',
  description: 'Upload a file as an asset of an existing release. host: github|atomgit; repo owner/repo; tag; file path (must exist).',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: "'github' or 'atomgit'" },
      repo: { type: 'string', description: 'owner/repo' },
      tag: { type: 'string', description: 'release tag' },
      file: { type: 'string', description: 'local file path to upload' },
    },
    required: ['host', 'repo', 'tag', 'file'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { host, err } = hostOf(args);
    if (!host || err) return err!;
    const g = await guard(host);
    if (g) return g;
    const file = isAbsolute(String(args.file ?? '')) ? String(args.file ?? '') : resolve(ctx.cwd, String(args.file ?? ''));
    try { await import('node:fs/promises').then((f) => f.access(file)); }
    catch { return { output: `file not found: ${file}`, isError: true }; }
    const r = await forgeRun(host, releaseUploadArgs(host, String(args.repo ?? ''), String(args.tag ?? ''), file), { cwd: ctx.cwd });
    return { output: r.output, isError: !r.ok };
  },
};

export const forgeRawTool: Tool = {
  name: 'forge_raw',
  description: 'DANGEROUS: pass raw arguments straight to gh/ag (host selects the binary). Only for operations the dedicated forge_* tools cannot express. Approval-gated; YOLO/auto modes pass it through.',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: "'github' or 'atomgit'" },
      args: { type: 'array', items: { type: 'string' }, description: 'raw CLI arguments, e.g. ["api","user"]' },
    },
    required: ['host', 'args'],
  },
  needsApproval: () => true,
  async execute(args, ctx): Promise<ToolResult> {
    const { host, err } = hostOf(args);
    if (!host || err) return err!;
    if (!Array.isArray(args.args) || !args.args.length) return { output: 'args must be a non-empty array of strings', isError: true };
    const r = await forgeRun(host, args.args.map(String), { cwd: ctx.cwd });
    return { output: `[${FORGE_BINS[host]} ${args.args.map(String).join(' ')}]\n${r.output}`, isError: !r.ok };
  },
};

// ---------------- login guidance ----------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Start the web login flow and poll auth status until it succeeds or the
 *  deadline passes. The device code / URL (gh prints them; ag opens the
 *  browser) go to stderr immediately so terminal frontends show them during
 *  the wait, and into the final result either way. */
export async function forgeLogin(host: ForgeHost, opts: { pollMs?: number; timeoutMs?: number; startFlow?: boolean } = {}): Promise<ToolResult> {
  const bin = FORGE_BINS[host];
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 4_000;
  const already = await forgeDetectHost(host);
  if (!already.installed) return { output: installHint(host), isError: true };
  if (already.loggedIn) return { output: `already logged in to ${host} as ${already.user ?? '(user unknown)'} — nothing to do.` };

  let early = '';
  if (opts.startFlow !== false) {
    const flow = host === 'github' ? `${bin} auth login --web -h github.com --skip-ssh-key` : `${bin} auth login`;
    const child = exec(flow, { timeout: timeoutMs + 30_000, windowsHide: true }, () => undefined);
    let buf = '';
    const grab = (d: unknown) => { buf += String(d); };
    child.stdout?.on('data', grab);
    child.stderr?.on('data', grab);
    await sleep(Math.min(6_000, Math.max(pollMs * 2, 500))); // give the CLI a moment to print the code/URL
    const code = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/.exec(buf)?.[1];
    const url = /https:\/\/\S+/.exec(buf)?.[0];
    early = [code ? `device code: ${code}` : '', url ? `authorization URL: ${url}` : ''].filter(Boolean).join('\n');
    if (early) console.error(`[forge_login:${host}] ${early} — complete it in the browser; waiting for the login to land...`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const st = await forgeDetectHost(host);
    if (st.loggedIn) return { output: `login complete: ${host} as ${st.user ?? '(user unknown)'}.${early ? `\n(${early})` : ''}` };
  }
  return {
    output: `login did not complete within ${Math.round(timeoutMs / 1000)}s.${early ? `\n${early}\nFinish it in the browser, then confirm with forge_status.` : `\nNo device code/URL was captured — start it manually: \`${bin} auth login\`, then confirm with forge_status.`}`,
    isError: true,
  };
}

export const forgeLoginTool: Tool = {
  name: 'forge_login',
  description: 'Guide the user through logging in to a forge (host: github|atomgit): starts `gh auth login --web` / `ag auth login` (the user completes it in the browser), shows the device code/URL, and polls until logged in (3 min timeout).',
  parameters: {
    type: 'object',
    properties: { host: { type: 'string', description: "'github' or 'atomgit'" } },
    required: ['host'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { host, err } = hostOf(args);
    if (!host || err) return err!;
    return forgeLogin(host);
  },
};

export const forgeTools: Tool[] = [
  forgeStatusTool, forgeRepoListTool, forgeRepoCreateTool,
  forgePrListTool, forgePrCreateTool, forgePrMergeTool, forgePrChecksTool,
  forgeIssueListTool, forgeIssueCreateTool,
  forgeReleaseCreateTool, forgeReleaseUploadTool,
  forgeRawTool, forgeLoginTool,
];
