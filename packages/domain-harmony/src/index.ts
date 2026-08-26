/**
 * @hmh/domain-harmony
 * HarmonyOS domain tools. Phase 0 ships the two zero-risk real ones
 * (device listing via hdc, toolchain presence check); the build/project/
 * signing lifecycle lands in Phase 1 on this same registration surface.
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '@hmh/kernel';

const exec = promisify(execFile);

function devecoHome(): string {
  return process.env.HM_DEVECO_HOME ?? 'C:\\DevEco-Studio';
}

async function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: (stdout || stderr || '(no output)').trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').slice(0, 2000) };
  }
}

async function findHdc(): Promise<string> {
  // PATH first, then the DevEco SDK layout
  const p = await run('hdc', ['--version'], 8000);
  if (p.ok) return 'hdc';
  const candidate = join(devecoHome(), 'sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe');
  try {
    await access(candidate);
    return candidate;
  } catch {
    return '';
  }
}

export const harmonyDevices: Tool = {
  name: 'harmony_devices',
  description:
    'List connected HarmonyOS devices/emulators (targets) via hdc. Returns the raw target list: index, state and connect string. Use before any device operation to learn the target id.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    const hdc = await findHdc();
    if (!hdc) {
      return {
        output: 'hdc not found. Install DevEco Studio (SDK component) or add its toolchains dir to PATH, or set HM_DEVECO_HOME.',
        isError: true,
      };
    }
    const r = await run(hdc, ['list', 'targets']);
    const lines = r.out.split('\n').map((l) => l.trim()).filter((l) => l && l !== '[Empty]');
    if (lines.length === 0) return { output: 'No devices connected. Start an emulator or plug in a device with USB debugging.' };
    return { output: lines.map((l, i) => `${i}: ${l}`).join('\n') };
  },
};

export const harmonyToolchainCheck: Tool = {
  name: 'harmony_toolchain_check',
  description:
    'Check the local HarmonyOS development toolchain: hdc (devices), hvigorw (build) and ohpm (packages), with resolved paths and versions where available.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    const lines: string[] = [];
    const hdc = await findHdc();
    if (hdc) {
      const v = await run(hdc, ['--version'], 8000);
      lines.push(`hdc: OK (${hdc}) ${v.out.split('\n')[0] ?? ''}`.trim());
    } else lines.push('hdc: MISSING');

    const hvigorw = join(devecoHome(), 'tools', 'hvigor', 'bin', 'hvigorw.bat');
    try {
      await access(hvigorw);
      lines.push(`hvigorw: OK (${hvigorw})`);
    } catch {
      lines.push(`hvigorw: MISSING (looked at ${hvigorw})`);
    }

    const ohpm = join(devecoHome(), 'tools', 'ohpm', 'bin', 'ohpm.bat');
    try {
      await access(ohpm);
      lines.push(`ohpm: OK (${ohpm})`);
    } catch {
      lines.push(`ohpm: MISSING (looked at ${ohpm})`);
    }
    return { output: lines.join('\n') };
  },
};

export const harmonyTools: Tool[] = [harmonyDevices, harmonyToolchainCheck];
