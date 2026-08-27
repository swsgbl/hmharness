/**
 * @hmh/domain-harmony - emulator management (no DevEco GUI)
 * DevEco's Emulator.exe is itself a headless CLI:
 *   Emulator.exe -hvd <name> -path <deployedDir> -imageRoot <imageRoot>
 * A deployed device is just: lists.json entry + instance dir with two
 * key=value INIs (qemu overlays are created on first boot). So hmharness
 * can list/start/stop/create/delete emulators entirely from the CLI - the
 * IDE never needs to open. Creating NEW device TYPES still requires an
 * image downloaded via DevEco's component manager (account-bound); new
 * INSTANCES of installed images are fully self-serve here.
 */
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { accessSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '@hmh/kernel';

const exec = promisify(execFile);

function localAppData(): string {
  return process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local');
}
export function deployedDir(): string {
  return join(localAppData(), 'Huawei', 'Emulator', 'deployed');
}
export function imageRoot(): string {
  return join(localAppData(), 'Huawei', 'Sdk');
}
function emulatorExe(): string {
  return join(process.env.HM_DEVECO_HOME ?? 'C:\\DevEco-Studio', 'tools', 'emulator', 'Emulator.exe');
}

interface DeployedDevice {
  name: string;
  apiVersion?: string;
  resolutionWidth?: string;
  resolutionHeight?: string;
  diagonalSize?: string;
  density?: string;
  type?: string;
  uuid?: string;
  version?: string;
  imageDir?: string;
  showVersion?: string;
  path?: string;
  [k: string]: unknown;
}

async function readLists(): Promise<DeployedDevice[]> {
  try {
    return JSON.parse(await readFile(join(deployedDir(), 'lists.json'), 'utf8')) as DeployedDevice[];
  } catch {
    return [];
  }
}

async function writeLists(devices: DeployedDevice[]): Promise<void> {
  await writeFile(join(deployedDir(), 'lists.json'), JSON.stringify(devices, null, '\t'), 'utf8');
}

async function hdcTargets(): Promise<string[]> {
  try {
    const { stdout } = await exec('hdc', ['list', 'targets'], { timeout: 8000, windowsHide: true });
    return stdout.split('\n').map((l) => l.trim()).filter((l) => l && l !== '[Empty]');
  } catch {
    return [];
  }
}

/** Emulator processes with their -hvd device name (Windows CIM query). */
async function runningEmulators(): Promise<Array<{ pid: number; hvd: string }>> {
  try {
    const { stdout } = await exec('powershell', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Emulator.exe' } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`,
    ], { timeout: 15000, windowsHide: true });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [pidStr, cmd] = l.split('|');
      // -hvd "Name With Spaces" or -hvd Simple
      const m = (cmd ?? '').match(/-hvd\s+"([^"]+)"|-hvd\s+([^\s]+)/);
      return { pid: Number(pidStr), hvd: m?.[1] ?? m?.[2] ?? '?' };
    });
  } catch {
    return [];
  }
}

async function waitTargets(before: Set<string>, ms: number): Promise<string[]> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const now = await hdcTargets();
    const fresh = now.filter((t) => !before.has(t));
    if (fresh.length > 0) return now;
  }
  return await hdcTargets();
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

export const harmonyEmulatorList: Tool = {
  name: 'harmony_emulator_list',
  description:
    'List HarmonyOS emulators: deployed devices (name/type/version/resolution + running state) and installed system images. Read-only. Pair with harmony_emulator_start / harmony_devices.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    const [devices, running, targets] = await Promise.all([readLists(), runningEmulators(), hdcTargets()]);
    let images: string[] = [];
    try {
      const verDirs = await readdir(join(imageRoot(), 'system-image'));
      for (const v of verDirs) {
        for (const t of await readdir(join(imageRoot(), 'system-image', v))) images.push(`${v}/${t}`);
      }
    } catch {
      /* no images */
    }
    const lines: string[] = ['deployed devices:'];
    if (devices.length === 0) lines.push('  (none - create one with harmony_emulator_create)');
    for (const d of devices) {
      const run = running.some((r) => r.hvd === d.name);
      lines.push(`  ${d.name} [${d.type ?? '?'} · ${d.showVersion ?? d.version ?? '?'} · ${d.resolutionWidth ?? '?'}x${d.resolutionHeight ?? '?'}] ${run ? 'RUNNING' : 'stopped'}`);
    }
    lines.push(`hdc targets: ${targets.length ? targets.join(', ') : '(none)'}`, 'installed images:');
    for (const i of images) lines.push(`  ${i}`);
    return { output: lines.join('\n') };
  },
};

export const harmonyEmulatorStart: Tool = {
  name: 'harmony_emulator_start',
  description:
    'Start a deployed emulator headlessly (spawns Emulator.exe directly - no DevEco GUI). Boots take 30-90s; the tool polls until the device appears in hdc (max 3 min). Heavy: each instance uses ~4 GB RAM.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'deployed device name (from harmony_emulator_list; default: the only/first one)' } },
    required: [],
  },
  needsApproval: () => true,
  async execute(args) {
    const exe = emulatorExe();
    try {
      accessSync(exe);
    } catch {
      return { output: `Emulator.exe not found at ${exe}. Install DevEco Studio (the emulator component).`, isError: true };
    }
    const devices = await readLists();
    const dev = typeof args.name === 'string' && args.name ? devices.find((d) => d.name === args.name) : devices[0];
    if (!dev) return { output: `Deployed device "${args.name ?? '(any)'}" not found. Use harmony_emulator_list / harmony_emulator_create.`, isError: true };
    const running = await runningEmulators();
    if (running.some((r) => r.hvd === dev.name)) {
      return { output: `${dev.name} is already running.` };
    }
    const before = new Set(await hdcTargets());
    // headless launch: the exact invocation DevEco itself uses
    const child = spawn(exe, ['-hvd', dev.name, '-path', deployedDir(), '-imageRoot', imageRoot()], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    const after = await waitTargets(before, 180_000);
    const fresh = after.filter((t) => !before.has(t));
    return {
      output: [
        `started ${dev.name} (pid ${child.pid}).`,
        after.length > 0 ? `hdc targets now: ${after.join(', ')}` : 'no hdc target appeared yet - first boot may take longer; check harmony_devices in a minute.',
        ...(fresh.length ? [`new target: ${fresh.join(', ')}`] : []),
      ].join('\n'),
    };
  },
};

export const harmonyEmulatorStop: Tool = {
  name: 'harmony_emulator_stop',
  description:
    'Stop running emulator(s) by terminating their exact Emulator.exe process (matched via -hvd name; state on disk is preserved like a power loss - Android-style cold stop). With a name, stops only that instance; with no name, stops ALL running emulators. Requires approval.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'device name (omit to stop all running emulators)' } },
    required: [],
  },
  needsApproval: () => true,
  async execute(args) {
    const running = await runningEmulators();
    if (running.length === 0) return { output: 'No emulators running.' };
    const targets = typeof args.name === 'string' && args.name ? running.filter((r) => r.hvd === args.name) : running;
    if (targets.length === 0) return { output: `No running emulator named "${args.name}". Running: ${running.map((r) => r.hvd).join(', ')}`, isError: true };
    for (const t of targets) {
      try {
        await exec('taskkill', ['/F', '/PID', String(t.pid)], { timeout: 15000, windowsHide: true });
      } catch {
        /* already gone */
      }
    }
    return { output: `stopped: ${targets.map((t) => `${t.hvd} (pid ${t.pid})`).join(', ')}` };
  },
};

export const harmonyEmulatorCatalog: Tool = {
  name: 'harmony_emulator_catalog',
  description:
    'List the full Huawei device catalog (productConfig.json: phones/tablets/2in1/wearables with resolution/density/diagonal) cross-referenced with locally installed images - shows which device variants can be deployed RIGHT NOW vs which need a one-time image download via DevEco component manager (account-bound; no public anonymous channel exists).',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    const lines: string[] = ['device catalog (from DevEco productConfig.json):'];
    try {
      const cat = JSON.parse(await readFile(join(imageRoot(), 'productConfig.json'), 'utf8')) as Record<string, Array<Record<string, string>>>;
      let images = '';
      try {
        const v = (await readdir(join(imageRoot(), 'system-image')))[0] ?? '';
        images = (await readdir(join(imageRoot(), 'system-image', v))).join(',');
      } catch {
        /* none */
      }
      for (const [type, devices] of Object.entries(cat)) {
        lines.push(`${type}: ${devices.map((d) => `${d.name}(${d.screenWidth}x${d.screenHeight}@${d.screenDensity})`).join(' · ')}`);
      }
      lines.push(`local images: ${images || '(none)'}`);
      lines.push('variants of installed types are deployable headlessly (harmony_emulator_create model=...); other types need one GUI-side image download.');
    } catch {
      lines.push('productConfig.json not found - install DevEco Studio first.');
    }
    return { output: lines.join('\n') };
  },
};

export const harmonyEmulatorCreate: Tool = {
  name: 'harmony_emulator_create',
  description:
    'Create (deploy) a NEW emulator instance - no DevEco GUI. Two sources: clone an existing deployed device (from=...), or materialize a CATALOG VARIANT (model="Pura 90 Pro" etc. from harmony_emulator_catalog) on the installed image with that model\'s screen specs - "various devices" without downloading anything. Fresh identity each time (new uuid, empty data). New device TYPES (tablet/wearable) need their image installed once via DevEco component manager. Requires approval.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'new instance name (letters/digits/spaces)' },
      from: { type: 'string', description: 'existing deployed device to clone (default: first)' },
      model: { type: 'string', description: 'catalog model name (e.g. "Pura 90 Pro") to take screen specs from, overriding the clone source' },
    },
    required: ['name'],
  },
  needsApproval: () => true,
  async execute(args) {
    const name = String(args.name ?? '').trim();
    if (!/^[\w][\w \-]{0,30}$/.test(name)) return { output: 'Invalid name (letters/digits/spaces, max 31 chars, not starting with a space).', isError: true };
    const devices = await readLists();
    if (devices.some((d) => d.name === name)) return { output: `Device "${name}" already exists.`, isError: true };
    const src = typeof args.from === 'string' && args.from ? devices.find((d) => d.name === args.from) : devices[0];
    if (!src) {
      return { output: 'No deployed device to clone a hardware profile from, and no image default available headlessly. Create the first device once in DevEco, then hmharness can clone infinitely.', isError: true };
    }
    const instPath = join(deployedDir(), name);
    await mkdir(instPath, { recursive: true });

    // lists.json entry: cloned profile (+ optional catalog-variant screen specs), fresh identity
    const entry: DeployedDevice = {
      ...src,
      name,
      uuid: randomUUID(),
      path: instPath.replace(/\\/g, '/'),
    };
    if (typeof args.model === 'string' && args.model) {
      try {
        const cat = JSON.parse(await readFile(join(imageRoot(), 'productConfig.json'), 'utf8')) as Record<string, Array<Record<string, string>>>;
        const spec = Object.values(cat).flat().find((d) => d.name === args.model);
        if (!spec) {
          await rm(instPath, { recursive: true, force: true });
          return { output: `Model "${args.model}" not in catalog. See harmony_emulator_catalog.`, isError: true };
        }
        Object.assign(entry, {
          resolutionWidth: spec.screenWidth,
          resolutionHeight: spec.screenHeight,
          density: spec.screenDensity,
          diagonalSize: spec.screenDiagonal,
          productModel: spec.name,
        });
      } catch {
        /* productConfig unavailable - keep clone profile */
      }
    }
    delete (entry as Record<string, unknown>).extra;
    await writeLists([...devices, entry]);

    // <name>..ini pointer
    await writeFile(join(deployedDir(), `${name}.ini`), `hvd.ini.encoding=UTF-8\npath=${instPath.replace(/\\/g, '/')}\n`, 'utf8');

    // config.ini / hardware-qemu.ini: clone from source instance, rewrite identity paths
    for (const f of ['config.ini', 'hardware-qemu.ini'] as const) {
      try {
        let text = await readFile(join(String(src.path), f), 'utf8');
        text = text
          .split('\n')
          .map((line) => {
            if (/^name=/.test(line)) return `name=${name}`;
            if (/^hvd\.(name|id)=/.test(line)) return `hvd.${line.split('=')[0]}=${name}`;
            if (/^uuid=/.test(line)) return `uuid=${entry.uuid}`;
            if (/^productModel=/.test(line)) return `productModel=${name}`;
            if (/^instancePath=/.test(line)) return `instancePath=${instPath.replace(/\\/g, '/')}`;
            return line;
          })
          .join('\n');
        await writeFile(join(instPath, f), text, 'utf8');
      } catch {
        /* source config missing - first boot may still self-initialize */
      }
    }
    return { output: `created "${name}" (${entry.type ?? 'phone'} · ${entry.showVersion ?? ''}). Start it with harmony_emulator_start.` };
  },
};

export const harmonyEmulatorDelete: Tool = {
  name: 'harmony_emulator_delete',
  description: 'Delete a deployed emulator instance (data dir, lists entry, ini). Refuses while it is running. Destructive - requires approval.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'device name' } },
    required: ['name'],
  },
  needsApproval: () => true,
  async execute(args) {
    const name = String(args.name ?? '').trim();
    const running = await runningEmulators();
    if (running.some((r) => r.hvd === name)) return { output: `"${name}" is running - stop it first (harmony_emulator_stop).`, isError: true };
    const devices = await readLists();
    const dev = devices.find((d) => d.name === name);
    if (!dev) return { output: `No deployed device named "${name}".`, isError: true };
    await rm(join(deployedDir(), name), { recursive: true, force: true });
    await rm(join(deployedDir(), `${name}.ini`), { force: true });
    await writeLists(devices.filter((d) => d.name !== name));
    return { output: `deleted "${name}".` };
  },
};

export const emulatorTools: Tool[] = [
  harmonyEmulatorList,
  harmonyEmulatorCatalog,
  harmonyEmulatorStart,
  harmonyEmulatorStop,
  harmonyEmulatorCreate,
  harmonyEmulatorDelete,
];
