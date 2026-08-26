/**
 * @hmh/domain-ops - issues (keeper v2)
 * The issue half of the old hm-keeper, on the gh CLI instead of hand-rolled
 * API clients. Behavior spec preserved from the old line (see
 * docs/MIGRATION-ASSESSMENT.md):
 *   - AI only DRAFTS; every publication (comment / new issue / PR) goes
 *     through the kernel approval gate - the y/N prompt IS the old
 *     "user approved issue <n>" exact-phrase gate, mechanically stricter.
 *   - published content always carries the keeper identity footer.
 *   - PRs open in draft mode with a plan card body.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '@hmh/kernel';

const exec = promisify(execFile);

const KEEPER_FOOTER = '\n\n---\n_via hmh-keeper (hmharness · draft by AI, published with human approval)_';

async function gh(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec('gh', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out: (stdout || stderr || '(no output)').trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').slice(0, 2000) };
  }
}

function parseRepo(repo: string): string {
  const r = repo.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) {
    throw new Error(`repo must look like owner/name, got "${r}"`);
  }
  return r;
}

export const harmonyOpsIssueList: Tool = {
  name: 'harmony_ops_issue_list',
  description:
    'List GitHub issues for a repo (owner/name) via gh. Read-only. Returns number, title, author, updated time as JSON lines. Draft input for issue triage - pair with harmony_ops_issue_view before proposing replies.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'GitHub repo as owner/name' },
      state: { type: 'string', description: 'open | closed | all (default open)' },
      limit: { type: 'number', description: 'max issues (default 10, max 50)' },
    },
    required: ['repo'],
  },
  async execute(args) {
    let repo: string;
    try {
      repo = parseRepo(String(args.repo));
    } catch (err) {
      return { output: String(err), isError: true };
    }
    const state = ['open', 'closed', 'all'].includes(String(args.state)) ? String(args.state) : 'open';
    const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 50);
    const r = await gh([
      'issue', 'list', '-R', repo,
      '--state', state, '--limit', String(limit),
      '--json', 'number,title,state,author,updatedAt',
    ]);
    if (!r.ok) return { output: `gh failed (is gh authenticated?):\n${r.out}`, isError: true };
    const items = JSON.parse(r.out) as Array<{ number: number; title: string; state: string; author?: { login?: string }; updatedAt: string }>;
    if (items.length === 0) return { output: `No ${state} issues in ${repo}.` };
    return { output: items.map((i) => `#${i.number} [${i.state}] ${i.title} — @${i.author?.login ?? '?'} · ${i.updatedAt?.slice(0, 10) ?? ''}`).join('\n') };
  },
};

export const harmonyOpsIssueView: Tool = {
  name: 'harmony_ops_issue_view',
  description: 'Read one GitHub issue with its comments (gh issue view). Read-only.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'GitHub repo as owner/name' },
      number: { type: 'number', description: 'issue number' },
    },
    required: ['repo', 'number'],
  },
  async execute(args) {
    let repo: string;
    try {
      repo = parseRepo(String(args.repo));
    } catch (err) {
      return { output: String(err), isError: true };
    }
    const r = await gh(['issue', 'view', String(Number(args.number)), '-R', repo, '--json', 'number,title,state,body,comments,author']);
    if (!r.ok) return { output: r.out, isError: true };
    const i = JSON.parse(r.out) as { number: number; title: string; state: string; body: string | null; author?: { login?: string }; comments?: Array<{ author?: { login?: string }; body: string }> };
    const comments = (i.comments ?? []).map((c, idx) => `--- comment ${idx + 1} @${c.author?.login ?? '?'} ---\n${c.body}`).join('\n\n');
    return { output: `#${i.number} [${i.state}] ${i.title} (by @${i.author?.login ?? '?'})\n\n${i.body ?? '(empty body)'}\n\n${comments || '(no comments)'}`.slice(0, 20_000) };
  },
};

export const harmonyOpsIssueCreate: Tool = {
  name: 'harmony_ops_issue_create',
  description:
    'Create a GitHub issue (PUBLICATION - requires human approval via the gate). AI drafts the title/body; the approval prompt is the publication decision. A keeper identity footer is appended automatically.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'GitHub repo as owner/name' },
      title: { type: 'string', description: 'issue title' },
      body: { type: 'string', description: 'issue body markdown (the draft)' },
    },
    required: ['repo', 'title', 'body'],
  },
  needsApproval: () => true,
  async execute(args) {
    let repo: string;
    try {
      repo = parseRepo(String(args.repo));
    } catch (err) {
      return { output: String(err), isError: true };
    }
    const r = await gh(['issue', 'create', '-R', repo, '--title', String(args.title), '--body', String(args.body) + KEEPER_FOOTER]);
    if (!r.ok) return { output: r.out, isError: true };
    return { output: `created: ${r.out}` };
  },
};

export const harmonyOpsIssueComment: Tool = {
  name: 'harmony_ops_issue_comment',
  description:
    'Comment on a GitHub issue (PUBLICATION - requires human approval via the gate). Never closes, never edits others\' comments; keeper identity footer appended automatically.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'GitHub repo as owner/name' },
      number: { type: 'number', description: 'issue number' },
      body: { type: 'string', description: 'comment markdown (the AI draft)' },
    },
    required: ['repo', 'number', 'body'],
  },
  needsApproval: () => true,
  async execute(args) {
    let repo: string;
    try {
      repo = parseRepo(String(args.repo));
    } catch (err) {
      return { output: String(err), isError: true };
    }
    const r = await gh(['issue', 'comment', String(Number(args.number)), '-R', repo, '--body', String(args.body) + KEEPER_FOOTER]);
    if (!r.ok) return { output: r.out, isError: true };
    return { output: `commented: ${r.out}` };
  },
};

export const harmonyOpsPrDraft: Tool = {
  name: 'harmony_ops_pr_draft',
  description:
    'Open a DRAFT pull request (PUBLICATION - requires human approval). Always --draft; the body becomes the plan card (what/why/how to test). Keeper identity footer appended.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'GitHub repo as owner/name' },
      title: { type: 'string', description: 'PR title' },
      body: { type: 'string', description: 'plan card: what / why / how to test' },
      head: { type: 'string', description: 'head branch with the changes' },
      base: { type: 'string', description: 'base branch (default main)' },
    },
    required: ['repo', 'title', 'body', 'head'],
  },
  needsApproval: () => true,
  async execute(args) {
    let repo: string;
    try {
      repo = parseRepo(String(args.repo));
    } catch (err) {
      return { output: String(err), isError: true };
    }
    const r = await gh([
      'pr', 'create', '-R', repo, '--draft',
      '--title', String(args.title),
      '--body', String(args.body) + KEEPER_FOOTER,
      '--head', String(args.head),
      '--base', String(args.base ?? 'main'),
    ]);
    if (!r.ok) return { output: r.out, isError: true };
    return { output: `draft PR opened: ${r.out}` };
  },
};

export const issueTools: Tool[] = [harmonyOpsIssueList, harmonyOpsIssueView, harmonyOpsIssueCreate, harmonyOpsIssueComment, harmonyOpsPrDraft];
