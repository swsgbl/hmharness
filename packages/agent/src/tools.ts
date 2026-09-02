/**
 * @hmh/agent - base tools
 * The general coding-agent toolset: read, write, list, a guarded shell
 * runner, long-term memory, and image viewing (vision model). Deny-first
 * guard on obviously destructive one-liners; approvals live in the kernel.
 */
import { exec } from 'node:child_process';
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chatVision, homeDir, loadConfig, resolveProvider, type ProviderConfig, type Tool } from '@hmh/kernel';

const execCb = promisify(exec);

const DENY_PATTERNS: Array<{ re: RegExp; why: string }> = [
  // recursive deletes aimed at ROOT/HOME/SYSTEM targets only - relative
  // subdirectories are legitimate work (the approval gate still covers them;
  // a blanket ban made the agent unable to clean its own scratch dirs)
  { re: /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+["']?[/~"']|rm\s+-rf?\s+[CcJj]:\\?\/?(\s|$)/i, why: 'recursive delete of a root/home path' },
  { re: /(?:rd|rmdir)\s+\/s[^|;&]{0,24}["']?(?:[a-z]:\\(?:\s|["']|$)|[a-z]:\\(?:windows|program files(?: \(x86\))?|users|programdata)(?:\\|\s|["']|$)|\/(?:\s|["']|$)|~|%userprofile%|%homedrive%)/i, why: 'recursive delete of a root/system/home path' },
  { re: /remove-item\s+[^|;&]{0,40}-(?:recurse|force)[^|;&]{0,8}-(?:force|recurse)[^|;&]{0,12}["']?(?:[a-z]:\\(?:\s|["']|$)|[a-z]:\\(?:windows|program files(?: \(x86\))?|users|programdata)(?:\\|\s|["']|$)|~|%userprofile%|%homedrive%)/i, why: 'recursive delete of a system/home path' },
  { re: /format\s+[a-z]:/i, why: 'drive format' },
  { re: /shutdown|restart\s+computer|taskkill\s+\/f\s+\/im\s+explorer/i, why: 'system power/shell action' },
  { re: /reg\s+(delete|add).*(Run|CurrentVersion)/i, why: 'autostart registry mutation' },
  { re: /curl[^|;&]{0,80}\|\s*(ba)?sh|iwr[^|;&]{0,80}\|\s*iex|set-executionpolicy\s+unrestricted/i, why: 'remote-script-to-shell pipe / unrestricted execution policy' },
];

function safePath(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a text file. Returns the full content (truncated at 60k chars).',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'file path (absolute or relative to cwd)' } },
    required: ['path'],
  },
  async execute(args, ctx) {
    try {
      const text = await readFile(safePath(String(args.path), ctx.cwd), 'utf8');
      return { output: text.length > 60_000 ? text.slice(0, 60_000) + '\n...[truncated]' : text };
    } catch (err) {
      return { output: String(err), isError: true };
    }
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write a text file (creates or overwrites). Use for code, config, docs.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'file path' },
      content: { type: 'string', description: 'full file content' },
    },
    required: ['path', 'content'],
  },
  needsApproval: () => true,
  async execute(args, ctx) {
    try {
      const p = safePath(String(args.path), ctx.cwd);
      // the agent overwriting its own live config is high-blast-radius:
      // snapshot first so a bad rewrite is one copy away from recovery
      let backupNote = '';
      if (p === join(ctx.home, 'config.json')) {
        const bak = p + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
        await copyFile(p, bak).then(() => { backupNote = ` (backup: ${bak})`; }).catch(() => { /* first write */ });
      }
      await writeFile(p, String(args.content ?? ''), 'utf8');
      return { output: `wrote ${String(args.content ?? '').length} chars to ${p}${backupNote}` };
    } catch (err) {
      return { output: String(err), isError: true };
    }
  },
};

export const listDirTool: Tool = {
  name: 'list_dir',
  description: 'List a directory: names with d/- prefix and size.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'directory path (default cwd)' } },
    required: [],
  },
  async execute(args, ctx) {
    try {
      const dir = args.path ? safePath(String(args.path), ctx.cwd) : ctx.cwd;
      const entries = await readdir(dir, { withFileTypes: true });
      const lines = entries.slice(0, 300).map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`);
      return { output: `${dir}\n${lines.join('\n') || '(empty)'}` };
    } catch (err) {
      return { output: String(err), isError: true };
    }
  },
};

/** Host-shell pipe preflight: on Windows cmd, Unix-isms fail with cryptic
 *  mojibake and the model retries for many turns. Only the FIRST word of
 *  each host segment (split on | || && ;) is checked - Unix words inside
 *  arguments (docker exec c ls /app) belong to the container and stay legal.
 *  (Pure, testable.) */
export function unixPipeOnWindows(command: string, platform: string = process.platform): string | null {
  if (platform !== 'win32') return null;
  const eq: Record<string, string> = {
    head: 'more (pager) or node -e', tail: 'powershell -NoProfile -Command "Get-Content -Tail N"',
    grep: 'findstr /i "pattern" file', awk: 'node -e', sed: 'node -e',
    wc: 'powershell -Command "(Get-Content f).Count"', cat: 'type file',
    ls: 'dir /b', less: 'more', which: 'where name',
  };
  for (const seg of command.split(/\|\||&&|[|;]/)) {
    const first = (/^[\s"']*([\w.-]+)/.exec(seg)?.[1] ?? '').toLowerCase();
    if (eq[first]) {
      return `Refused before running: '${first}' does not exist in cmd.exe (the host shell). Use: ${eq[first]} . Do NOT retry the same pipeline.`;
    }
  }
  return null;
}

/** Repeat-failure short-circuit: the same command that already failed twice
 *  is refused without executing - the model repeating it 10x burned ~700k
 *  prompt tokens in one audited session. (Module-level, session-scoped.) */
const failedCommands = new Map<string, number>();

export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    'Run a shell command (one line, cmd on Windows / sh elsewhere) with a timeout. Prefer focused commands; read output carefully before deciding next steps.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'the command line to run' },
      timeout_ms: { type: 'number', description: 'timeout in ms (default 60000, max 300000)' },
    },
    required: ['command'],
  },
  needsApproval: () => true,
  async execute(args, ctx) {
    const command = String(args.command ?? '');
    for (const d of DENY_PATTERNS) {
      if (d.re.test(command)) {
        return { output: `Refused: ${d.why}. Ask the user to run it manually if truly intended.`, isError: true };
      }
    }
    const unix = unixPipeOnWindows(command);
    if (unix) return { output: unix, isError: true };
    const fails = failedCommands.get(command) ?? 0;
    if (fails >= 2) {
      return { output: `Refused: this exact command already failed ${fails} times this session. Change strategy (different command, different tool, or ask the user) instead of repeating it.`, isError: true };
    }
    const timeout = Math.min(Number(args.timeout_ms ?? 60_000), 300_000);
    try {
      const { stdout, stderr } = await execCb(command, {
        cwd: ctx.cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
      failedCommands.delete(command);
      return { output: (out.trim() || '(no output)').slice(0, 60_000) };
    } catch (err: unknown) {
      failedCommands.set(command, fails + 1);
      const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      const parts = [e.stdout, e.stderr, e.killed ? '(timed out)' : null, e.message].filter(Boolean).join('\n');
      return { output: parts.slice(0, 60_000), isError: true };
    }
  },
};

export const rememberTool: Tool = {
  name: 'remember',
  description:
    'Persist a note to long-term memory (survives restarts, loaded into future sessions). Use for user preferences, project facts, and hard-won lessons - not transient details.',
  parameters: {
    type: 'object',
    properties: { note: { type: 'string', description: 'the fact/lesson to remember, one line preferred' } },
    required: ['note'],
  },
  async execute(args) {
    try {
      const { appendMemory } = await import('@hmh/evolution');
      await appendMemory(homeDir(), String(args.note ?? ''));
      return { output: 'remembered.' };
    } catch (err) {
      return { output: String(err), isError: true };
    }
  },
};

export const seeImageTool: Tool = {
  name: 'see_image',
  description:
    'Look at an image file (png/jpg/webp) with the configured vision model and answer a question about it, or describe it. Use for UI screenshots, rendered pages, photos of device screens - anything visual. Requires a vision provider in config.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'image file path (absolute or relative to cwd)' },
      question: { type: 'string', description: 'what to answer about the image (default: describe it)' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const cfg = await loadConfig();
    const hasVision = Boolean(cfg.vision || (cfg.routing?.vision && cfg.providers?.[cfg.routing.vision]));
    if (!hasVision) {
      return {
        output: 'No vision provider configured. Add a "vision" block or providers+routing.vision to HMH_HOME/config.json.',
        isError: true,
      };
    }
    const p = safePath(String(args.path ?? ''), ctx.cwd);
    let data: Buffer;
    try {
      data = await readFile(p);
    } catch (err) {
      return { output: String(err), isError: true };
    }
    if (data.length > 6 * 1024 * 1024) {
      return { output: `Image too large (${(data.length / 1024 / 1024).toFixed(1)} MB, max 6 MB).`, isError: true };
    }
    const mime = /\.(jpg|jpeg)$/i.test(p) ? 'image/jpeg' : /\.webp$/i.test(p) ? 'image/webp' : 'image/png';
    const url = `data:${mime};base64,${data.toString('base64')}`;
    const question = String(args.question ?? 'Describe this image precisely and concisely.');
    const chain: ProviderConfig[] = [resolveProvider(cfg, 'vision'), ...(cfg.visionFallbacks ?? [])].filter((x) => x.baseUrl);
    const errors: string[] = [];
    for (const provider of chain) {
      try {
        const answer = await chatVision(provider, question, url);
        return { output: `[${p}]\n${answer}` };
      } catch (err) {
        errors.push(`${(provider as { model?: string }).model ?? '?'}: ${String(err).slice(0, 120)}`);
      }
    }
    return { output: `all vision providers failed:\n${errors.join('\n')}`, isError: true };
  },
};

export const baseTools: Tool[] = [readFileTool, writeFileTool, listDirTool, runCommandTool, rememberTool, seeImageTool];
