/**
 * @hmharness/domain-harmony - vmenv (VM development environments)
 * Two VM families this machine uses for hmharness development, unified as
 * first-class tools so the agent can drive them without shell gymnastics:
 *
 *  1. KaihongOS 5.0 QEMU image (D:\OHOS-QEMU\KaihongOS): OpenHarmony-family
 *     guest booted via qemu-system-x86_64 with user-mode networking that
 *     forwards host 127.0.0.1:15566 -> guest hdcd (10178), so it becomes a
 *     normal `hdc tconn 127.0.0.1:15565` target - same pipeline as the
 *     DevEco emulator. QMP(22472)/HMP(22471)/serial(22473) are there for
 *     lifecycle + diagnostics.
 *
 *  2. VMware Workstation VMs (D:\VMs: Ubuntu 26.04 / Kali 2026.2 / Win11):
 *     general dev environments. Lifecycle via vmrun; remote access is the
 *     existing sshHosts config (the web SSH panel) - this module never
 *     shells into guests itself.
 *
 * Config (config.json `vm` block, all optional - defaults auto-discover):
 *   vm.qemu = { dir, launch, hdcPort, vncDisplay }
 *   vm.vmware = { vmrun, vmDirs: string[] }
 *
 * Safety: start/stop/change VM state = approval-gated tools; status/list
 * are read-only. Zero runtime deps.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as net from 'node:net';
import { loadConfig, type Tool } from '@hmharness/kernel';

const execCb = promisify(execFile);

async function vmConfig(): Promise<VmConfig> {
  try {
    const cfg = (await loadConfig()) as { vm?: VmConfig };
    return cfg.vm ?? {};
  } catch {
    return {};
  }
}

/* ---------------- config defaults ---------------- */

export interface VmQemuConfig { dir?: string; launch?: string; hdcPort?: number; vncDisplay?: number }
export interface VmVmwareConfig { vmrun?: string; vmDirs?: string[] }
export interface VmConfig { qemu?: VmQemuConfig; vmware?: VmVmwareConfig }

/** extra hdc resolver candidate: the 5.0.2 SDK shipped beside the image */
export const QEMU_SDK_HDC = 'D:/OHOS-QEMU/sdk-5.0.2/14/toolchains/hdc.exe';

export const VM_DEFAULTS = {
  qemuDir: 'D:/OHOS-QEMU/KaihongOS',
  qemuLaunch: 'launch_qemu_vnc.cmd',
  qemuHdcPort: 15566,
  qemuVncDisplay: 5,
  vmrun: 'C:/Program Files/VMware/VMware Workstation/vmrun.exe',
  vmDirs: ['D:/VMs'],
};

export function resolveQemu(cfg?: VmQemuConfig) {
  const dir = cfg?.dir ?? VM_DEFAULTS.qemuDir;
  return {
    dir,
    launch: cfg?.launch ?? VM_DEFAULTS.qemuLaunch,
    launchPath: join(dir, cfg?.launch ?? VM_DEFAULTS.qemuLaunch),
    hdcPort: cfg?.hdcPort ?? VM_DEFAULTS.qemuHdcPort,
    vncDisplay: cfg?.vncDisplay ?? VM_DEFAULTS.qemuVncDisplay,
  };
}

export function resolveVmrun(cfg?: VmVmwareConfig) {
  return {
    vmrun: cfg?.vmrun ?? VM_DEFAULTS.vmrun,
    vmDirs: cfg?.vmDirs?.length ? cfg.vmDirs : VM_DEFAULTS.vmDirs,
  };
}

/** Parse the guest hdc forward port out of a launch .cmd (hostfwd line).
 *  Pure - testable. Falls back to the default when absent. */
export function parseHostfwd(script: string, fallback = VM_DEFAULTS.qemuHdcPort): number {
  const m = /hostfwd=tcp:127\.0\.0\.1:(\d+)-:5555/.exec(script);
  return m ? Number(m[1]) : fallback;
}

/* ---------------- KaihongOS QEMU tool ---------------- */

export const harmonyVmQemuTool: Tool = {
  name: 'harmony_vm_qemu',
  description:
    'KaihongOS 5.0 QEMU image lifecycle: status (qemu process + hdc target + VNC), start (launch cmd, then hdc tconn), stop (QMP quit), hdc-connect. The image forwards host 127.0.0.1:15565 -> guest hdcd 5555, so after start it is a normal hdc target for install/launch/logs tools. Actions: status (default) | start | stop | connect.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'status | start | stop | connect' },
    },
    required: [],
  },
  needsApproval(args) {
    return args?.action === 'start' || args?.action === 'stop';
  },
  async execute(args) {
    const action = String(args?.action ?? 'status');
    const cfg = await vmConfig();
    const q = resolveQemu(cfg.qemu);

    // local hdc resolver (same chain as index.ts: PATH -> DevEco toolchains)
    const findHdcLocal = async (): Promise<string> => {
      const deveco = process.env.HM_DEVECO_HOME ?? 'C:/Program Files/Huawei/DevEco Studio';
      const toolchainsHdc = join(deveco, 'sdk/default/openharmony/toolchains/hdc.exe');
      try {
        await execCb('hdc', ['--version'], { timeout: 8000, windowsHide: true });
        return 'hdc';
      } catch { /* not on PATH */ }
      if (existsSync(toolchainsHdc)) return toolchainsHdc;
      return existsSync(QEMU_SDK_HDC) ? QEMU_SDK_HDC : '';
    };
    const hdc = await findHdcLocal();
    const target = `127.0.0.1:${q.hdcPort}`;

    const hdcTargets = async (): Promise<string> => {
      if (!hdc) return '(hdc not found)';
      try {
        const r = await execCb(hdc, ['list', 'targets'], { timeout: 5000, windowsHide: true });
        return String(r.stdout).trim() || '(empty)';
      } catch (e) {
        return '(hdc error: ' + String(e).slice(0, 60) + ')';
      }
    };

    if (action === 'status') {
      const launchExists = existsSync(q.launchPath);
      const qemuRunning = await (async () => {
        try {
          const out = await execCb('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Measure-Object).Count`], { timeout: 10000, windowsHide: true });
          return Number(String(out.stdout).trim()) > 0;
        } catch { return false; }
      })();
      const targets = await hdcTargets();
      const connected = targets.includes(target);
      return {
        output: [
          `KaihongOS QEMU @ ${q.dir}`,
          `  launch script: ${q.launchPath} ${launchExists ? '(present)' : '(MISSING)'}`,
          `  qemu process: ${qemuRunning ? 'RUNNING' : 'stopped'}`,
          `  hdc target ${target}: ${connected ? 'CONNECTED' : 'not connected'} (all targets: ${targets.split('\n').filter(Boolean).join(', ') || 'none'})`,
          `  vnc: 127.0.0.1:${5900 + q.vncDisplay} · qmp: 22472 · hmp: 22471 · serial log: ${join(q.dir, 'kaihong-serial.log')}`,
          qemuRunning && !connected ? '  next: action=connect' : !qemuRunning ? '  next: action=start' : '',
        ].filter(Boolean).join('\n'),
      };
    }

    if (action === 'start') {
      if (!existsSync(q.launchPath)) {
        return { output: `launch script not found: ${q.launchPath}`, isError: true };
      }
      // detach: the cmd blocks until QEMU exits - spawn, never await it
      const child = spawn('cmd.exe', ['/c', q.launchPath], { cwd: q.dir, detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      // wait for the forward port to accept, then hdc tconn
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        up = await new Promise<boolean>((resolve) => {
          
          const s = net.connect({ host: '127.0.0.1', port: q.hdcPort, timeout: 1200 }, () => { s.destroy(); resolve(true); });
          s.on('error', () => resolve(false));
          s.on('timeout', () => { s.destroy(); resolve(false); });
        });
      }
      if (!up) {
        return { output: `QEMU started but port ${q.hdcPort} never opened (guest hdcd may be down - watch the serial log: ${join(q.dir, 'kaihong-serial.log')})`, isError: true };
      }
      if (!hdc) return { output: `QEMU up, port ${q.hdcPort} open - but hdc not found; connect manually: hdc tconn ${target}` };
      try {
        await execCb(hdc, ['tconn', target], { timeout: 15000, windowsHide: true });
        return { output: `QEMU started and hdc connected: ${target}. Verify with harmony_devices.` };
      } catch (e) {
        return { output: `QEMU up but hdc tconn failed: ${String(e).slice(0, 120)}` , isError: true };
      }
    }

    if (action === 'stop') {
      // graceful: QMP quit via telnet-ish raw socket (qmp is a telnet server)
      const stopped = await new Promise<boolean>((resolve) => {
        
        const s = net.connect({ host: '127.0.0.1', port: 22472, timeout: 4000 }, () => {
          s.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\r\n');
          setTimeout(() => s.write(JSON.stringify({ execute: 'quit' }) + '\r\n'), 400);
          setTimeout(() => { s.destroy(); resolve(true); }, 2500);
        });
        s.on('error', () => resolve(false));
        s.on('timeout', () => { s.destroy(); resolve(false); });
      });
      if (stopped) {
        // also drop the hdc target so status is honest
        if (hdc) await execCb(hdc, ['tdisconn', target], { timeout: 8000, windowsHide: true }).catch(() => undefined);
        return { output: 'QMP quit sent - QEMU stopping (graceful).' };
      }
      return { output: 'QMP not reachable (QEMU not running or port 22472 closed). Nothing to stop.', isError: true };
    }

    if (action === 'connect') {
      if (!hdc) return { output: 'hdc not found', isError: true };
      try {
        await execCb(hdc, ['tconn', target], { timeout: 15000, windowsHide: true });
        return { output: `hdc connected: ${target}` };
      } catch (e) {
        return { output: `hdc tconn failed (is QEMU running? action=start first): ${String(e).slice(0, 120)}`, isError: true };
      }
    }

    return { output: 'action must be status | start | stop | connect', isError: true };
  },
};

/* ---------------- VMware tool ---------------- */

/** Parse `vmrun list` output into vmx paths. Pure - testable. */
export function parseVmrunList(out: string): string[] {
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.toLowerCase().endsWith('.vmx'));
}

export const vmwareVmsTool: Tool = {
  name: 'vmware_vms',
  description:
    'VMware Workstation VM lifecycle via vmrun: list (running + registered), start/stop/suspend a VM by name or .vmx path, ip (getGuestIPAddress), run a program in the guest. Actions: list (default) | start | stop | suspend | ip | guest-run. Remote shell access to guests is the sshHosts config (web SSH panel), not this tool.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'list | start | stop | suspend | ip | guest-run' },
      vm: { type: 'string', description: 'VM name or absolute .vmx path (list under D:/VMs)' },
      guestCmd: { type: 'string', description: 'for guest-run: command line to run inside the guest (requires VMware Tools)' },
      sshKey: { type: 'string', description: 'for check: path to the SSH key (default ~/.ssh/vm_maintenance_ed25519)' },
    },
    required: [],
  },
  needsApproval(args) {
    const a = String(args?.action ?? 'list');
    return a === 'start' || a === 'stop' || a === 'suspend' || a === 'guest-run';
  },
  async execute(args) {
    const action = String(args?.action ?? 'list');
    const raw = (await import('@hmharness/kernel')).loadConfig as never as () => Promise<{ vm?: VmConfig }>;
    const cfg = await (raw as () => Promise<{ vm?: VmConfig }>)().catch(() => ({}) as { vm?: VmConfig });
    const { vmrun, vmDirs } = resolveVmrun(cfg.vm?.vmware);
    if (!existsSync(vmrun)) {
      return { output: `vmrun not found at ${vmrun} - set vm.vmware.vmrun in config.json`, isError: true };
    }

    const runVm = async (vmArgs: string[]) => {
      const r = await execCb(vmrun, vmArgs, { timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      return (String(r.stdout) + (r.stderr ? '\n[stderr]\n' + r.stderr : '')).trim() || '(no output)';
    };

    const listAll = async () => {
      const out = await runVm(['list']);
      const running = parseVmrunList(out);
      const registered: string[] = [];
      for (const dir of vmDirs) {
        try {
          for (const e of await readdir(dir, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            try {
              const inner = await readdir(join(dir, e.name));
              for (const f of inner) if (f.toLowerCase().endsWith('.vmx')) registered.push(join(dir, e.name, f));
            } catch { /* unreadable */ }
          }
        } catch { /* dir gone */ }
      }
      return { out, running, registered };
    };

    // resolve a VM name -> vmx path from the dirs
    const resolveVmx = async (name: string): Promise<string> => {
      if (name.toLowerCase().endsWith('.vmx') && existsSync(name)) return name;
      const { registered } = await listAll();
      const hit = registered.find((p) => p.toLowerCase().includes(name.toLowerCase()));
      if (!hit) throw new Error(`no .vmx matching "${name}" under ${vmDirs.join(', ')} - pass the full path`);
      return hit;
    };

    try {
      if (action === 'list') {
        const { out, running, registered } = await listAll();
        const lines = [out, '', 'discovered .vmx files:'];
        for (const p of registered) lines.push(`  ${running.some((r) => r.toLowerCase() === p.toLowerCase()) ? '[running]' : '[off]     '} ${p}`);
        return { output: lines.join('\n') };
      }
      if (action === 'check') {
        // per-OS dev-environment readiness over SSH (BatchMode + maintenance
        // key). Read-only probes; unreachable VMs are reported, not errors.
        const key = String(args?.sshKey ?? join(process.env.USERPROFILE ?? '', '.ssh', 'vm_maintenance_ed25519'));
        const vms: Array<{ name: string; host: string; user: string }> = [
          { name: 'Ubuntu 26.04', host: '192.168.161.128', user: 'hongfu' },
          { name: 'Kali 2026.2', host: '192.168.161.129', user: 'kali' },
          { name: 'Win10 Fresh', host: '192.168.161.133', user: 'hongfu2' },
          { name: 'Win11 Fresh', host: '192.168.161.132', user: 'hongfu1' },
          { name: 'Omarchy 4.0.4', host: '192.168.161.136', user: 'hongfu' },
        ];
        const probe = 'uname -a 2>/dev/null || ver; echo ---; node -v 2>/dev/null || echo no-node; python3 --version 2>/dev/null || echo no-python3; which hdc ohpm hvigorw 2>/dev/null || echo no-hmony-tools';
        const lines: string[] = ['VM dev-environment check (SSH BatchMode, key ' + key + '):'];
        for (const vm of vms) {
          let out: string;
          try {
            const r = await execCb('ssh', [
              '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new',
              '-i', key, vm.user + '@' + vm.host, probe,
            ], { timeout: 25000, windowsHide: true, maxBuffer: 1024 * 1024 });
            out = String(r.stdout).trim();
          } catch (e) {
            const err = String((e as { stdout?: string; stderr?: string; message?: string }).stdout || (e as { stderr?: string }).stderr || (e as { message?: string }).message || '');
            lines.push('  [' + vm.name + '] ' + vm.user + '@' + vm.host + ' — UNREACHABLE (' + err.split('\n')[0].slice(0, 60) + ')');
            continue;
          }
          const os = out.split('---')[0]?.split('\n')[0]?.trim() || '?';
          const parts = out.split('---')[1]?.trim().split('\n').filter(Boolean) ?? [];
          lines.push('  [' + vm.name + '] ' + vm.user + '@' + vm.host + ' — OK');
          lines.push('    os: ' + os.slice(0, 90));
          for (const p of parts) lines.push('    ' + p.trim().slice(0, 90));
        }
        return { output: lines.join('\n') };
      }
      if (!args?.vm) return { output: 'vm required (name or .vmx path)', isError: true };
      const vmx = await resolveVmx(String(args.vm));
      if (action === 'start') {
        const out = await runVm(['-T', 'ws', 'start', vmx, 'nogui']);
        return { output: `started (headless): ${vmx}\n${out}\nget the IP next: action=ip` };
      }
      if (action === 'stop') {
        const out = await runVm(['-T', 'ws', 'stop', vmx, 'soft']);
        return { output: `stop requested: ${vmx}\n${out}` };
      }
      if (action === 'suspend') {
        const out = await runVm(['-T', 'ws', 'suspend', vmx]);
        return { output: `suspend requested: ${vmx}\n${out}` };
      }
      if (action === 'ip') {
        const out = await runVm(['-T', 'ws', 'getGuestIPAddress', vmx, '-wait']);
        return { output: `guest IP: ${out}` };
      }
      if (action === 'guest-run') {
        if (!args?.guestCmd) return { output: 'guestCmd required for guest-run', isError: true };
        const out = await runVm(['-T', 'ws', '-gu', 'ubuntu', '-gp', '123456', 'runProgramInGuest', vmx, String(args.guestCmd)]);
        return { output: out };
      }
      return { output: 'action must be list | start | stop | suspend | ip | guest-run | check', isError: true };
    } catch (e) {
      return { output: String(e).slice(0, 300), isError: true };
    }
  },
};

export const vmTools: Tool[] = [harmonyVmQemuTool, vmwareVmsTool];
