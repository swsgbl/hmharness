/**
 * @hmh/domain-harmony - project scaffold
 * Creates a minimal buildable HarmonyOS stage-model project (ArkTS entry +
 * single page + resources) tuned to the installed SDK via HM_SDK_VERSION
 * (default "6.1.1(24)"). Icons are generated PNGs (zlib + hand-rolled CRC -
 * no image dependency in the kernel's zero-dep spirit). The scaffold is
 * deliberately minimal: DevEco remains the full-featured authoring tool;
 * this exists so the agent can bootstrap a project and drive it through
 * build/install/launch without leaving the loop.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Tool } from '@hmh/kernel';

/* ------------------------------------------------------------------ */
/* Minimal PNG encoder (solid RGBA color, power-of-two sizes)          */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Solid-color RGBA PNG (used for app/start icons - content is cosmetic). */
export function solidPng(size: number, rgba: [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x++) {
    row[1 + x * 4] = rgba[0];
    row[2 + x * 4] = rgba[1];
    row[3 + x * 4] = rgba[2];
    row[4 + x * 4] = rgba[3];
  }
  const raw = Buffer.concat(Array(size).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Scaffold                                                           */
/* ------------------------------------------------------------------ */

export function sdkVersion(): string {
  return process.env.HM_SDK_VERSION ?? '6.1.1(24)';
}

function sanitizeIdent(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || 'app';
}

export async function scaffoldProject(dir: string, opts: { name?: string; bundleId?: string } = {}): Promise<{ root: string; bundleId: string; files: number }> {
  const root = resolve(dir);
  const name = opts.name ?? basename(root);
  const bundleId = opts.bundleId ?? `com.example.${sanitizeIdent(name)}`;
  const sdk = sdkVersion();
  const W = async (rel: string, content: string | Buffer) => {
    const p = join(root, rel);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, content, typeof content === 'string' ? 'utf8' : undefined);
    return 1;
  };

  let files = 0;
  files += await W('build-profile.json5', [
    '{',
    '  "app": {',
    '    "signingConfigs": [],',
    '    "products": [',
    '      {',
    '        "name": "default",',
    `        "compatibleSdkVersion": "${sdk}",`,
    '        "runtimeOS": "HarmonyOS"',
    '      }',
    '    ],',
    '    "buildModeSet": [',
    '      { "name": "debug" },',
    '      { "name": "release" }',
    '    ]',
    '  },',
    '  "modules": [',
    '    {',
    '      "name": "entry",',
    '      "srcPath": "./entry",',
    '      "targets": [',
    '        {',
    '          "name": "default",',
    '          "applyToProducts": [ "default" ]',
    '        }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '',
  ].join('\n'));

  files += await W('hvigor/hvigor-config.json5', ['{', '  "modelVersion": "5.0.0",', '  "dependencies": {}', '}', ''].join('\n'));
  files += await W(
    'hvigorfile.ts',
    [
      "import { appTasks } from '@ohos/hvigor-ohos-plugin';",
      '',
      'export default {',
      '  system: appTasks,',
      '  plugins: []',
      '}',
      '',
    ].join('\n'),
  );
  files += await W(
    'entry/hvigorfile.ts',
    [
      "import { hapTasks } from '@ohos/hvigor-ohos-plugin';",
      '',
      'export default {',
      '  system: hapTasks,',
      '  plugins: []',
      '}',
      '',
    ].join('\n'),
  );
  files += await W('oh-package.json5', [`{`, `  "modelVersion": "5.0.0",`, `  "name": "${sanitizeIdent(name)}",`, '  "version": "1.0.0",', '  "description": "scaffolded by hmharness",', '  "dependencies": {}', '}', ''].join('\n'));
  files += await W('.gitignore', ['/oh_modules/', '/build/', '/.hvigor/', '/.clangd/', '/.clang-format/', '/.clang-tidy/', '/local.properties', ''].join('\n'));

  files += await W('AppScope/app.json5', [
    '{',
    '  "app": {',
    `    "bundleName": "${bundleId}",`,
    '    "vendor": "hmharness",',
    '    "versionCode": 1000000,',
    '    "versionName": "1.0.0",',
    '    "icon": "$media:app_icon",',
    '    "label": "$string:app_name"',
    '  }',
    '}',
    '',
  ].join('\n'));
  files += await W('AppScope/resources/base/element/string.json', [
    '{',
    '  "string": [',
    `    { "name": "app_name", "value": "${name.replace(/"/g, '')}" }`,
    '  ]',
    '}',
    '',
  ].join('\n'));
  files += await W('AppScope/resources/base/media/app_icon.png', solidPng(96, [0x1f, 0x6f, 0xeb, 0xff]));

  files += await W('entry/oh-package.json5', ['{', '  "name": "entry",', '  "version": "1.0.0",', '  "description": "entry module",', '  "dependencies": {}', '}', ''].join('\n'));
  files += await W('entry/build-profile.json5', [
    '{',
    '  "apiType": "stageMode",',
    '  "buildOption": {},',
    '  "buildOptionSet": [',
    '    {',
    '      "name": "release",',
    '      "arkOptions": {',
    '        "obfuscation": {',
    '          "ruleOptions": {',
    '            "enable": false,',
    '            "files": [ "./obfuscation-rules.txt" ]',
    '          }',
    '        }',
    '      }',
    '    }',
    '  ],',
    '  "targets": [',
    '    { "name": "default" }',
    '  ]',
    '}',
    '',
  ].join('\n'));
  files += await W('entry/obfuscation-rules.txt', [
    '# Define project specific obfuscation rules here.',
    '# (obfuscation disabled in build-profile; file kept for structure parity)',
    '',
  ].join('\n'));

  files += await W('entry/src/main/module.json5', [
    '{',
    '  "module": {',
    '    "name": "entry",',
    '    "type": "entry",',
    '    "description": "$string:module_desc",',
    '    "mainElement": "EntryAbility",',
    '    "deviceTypes": [ "phone", "tablet", "2in1" ],',
    '    "deliveryWithInstall": true,',
    '    "installationFree": false,',
    '    "pages": "$profile:main_pages",',
    '    "abilities": [',
    '      {',
    '        "name": "EntryAbility",',
    '        "srcEntry": "./ets/entryability/EntryAbility.ets",',
    '        "exported": true,',
    '        "description": "$string:EntryAbility_desc",',
    '        "startWindowIcon": "$media:startIcon",',
    '        "startWindowBackground": "$color:start_window_background",',
    '        "label": "$string:EntryAbility_label"',
    '      }',
    '    ]',
    '  }',
    '}',
    '',
  ].join('\n'));

  files += await W('entry/src/main/ets/entryability/EntryAbility.ets', [
    "import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';",
    "import { hilog } from '@kit.PerformanceAnalysisKit';",
    "import { window } from '@kit.ArkUI';",
    '',
    'export default class EntryAbility extends UIAbility {',
    '  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {',
    "    hilog.info(0x0000, 'hmh', '%{public}s', 'EntryAbility onCreate');",
    '  }',
    '',
    '  onDestroy(): void {}',
    '',
    '  onWindowStageCreate(windowStage: window.WindowStage): void {',
    "    windowStage.loadContent('pages/Index', (err) => {",
    '      if (err.code) {',
    "        hilog.error(0x0000, 'hmh', 'Failed to load content: %{public}s', JSON.stringify(err));",
    '        return;',
    '      }',
    '    });',
    '  }',
    '',
    '  onWindowStageDestroy(): void {}',
    '  onForeground(): void {}',
    '  onBackground(): void {}',
    '}',
    '',
  ].join('\n'));

  files += await W('entry/src/main/ets/pages/Index.ets', [
    '@Entry',
    '@Component',
    'struct Index {',
    "  @State message: string = 'Hello HarmonyOS';",
    '',
    '  build() {',
    '    Column() {',
    '      Text(this.message)',
    '        .fontSize(40)',
    '        .fontWeight(FontWeight.Bold)',
    '    }',
    "    .width('100%')",
    "    .height('100%')",
    '    .justifyContent(FlexAlign.Center)',
    '  }',
    '}',
    '',
  ].join('\n'));

  files += await W('entry/src/main/resources/base/element/string.json', [
    '{',
    '  "string": [',
    '    { "name": "module_desc", "value": "entry module" },',
    `    { "name": "EntryAbility_desc", "value": "${name.replace(/"/g, '')}" },`,
    `    { "name": "EntryAbility_label", "value": "${name.replace(/"/g, '')}" }`,
    '  ]',
    '}',
    '',
  ].join('\n'));
  files += await W('entry/src/main/resources/base/element/color.json', [
    '{',
    '  "color": [',
    '    { "name": "start_window_background", "value": "#FFFFFF" }',
    '  ]',
    '}',
    '',
  ].join('\n'));
  files += await W('entry/src/main/resources/base/media/startIcon.png', solidPng(96, [0x00, 0x00, 0x00, 0xff]));
  files += await W('entry/src/main/resources/base/profile/main_pages.json', ['{', '  "src": [ "pages/Index" ]', '}', ''].join('\n'));

  return { root, bundleId, files };
}

export const harmonyProjectCreate: Tool = {
  name: 'harmony_project_create',
  description:
    'Scaffold a minimal buildable HarmonyOS project (stage model, ArkTS, entry module + one page) at the given path. Requires approval (it writes files). Follow up with harmony_build / harmony_install / harmony_launch.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'directory to create the project in (created if missing)' },
      name: { type: 'string', description: 'display name (default: directory basename)' },
      bundle_id: { type: 'string', description: 'bundle name (default: com.example.<name>)' },
    },
    required: ['path'],
  },
  needsApproval: () => true,
  async execute(args, ctx) {
    const dir = resolve(ctx.cwd, String(args.path ?? '.'));
    try {
      const r = await scaffoldProject(dir, {
        name: typeof args.name === 'string' ? args.name : undefined,
        bundleId: typeof args.bundle_id === 'string' ? args.bundle_id : undefined,
      });
      return { output: `created project at ${r.root} (bundle ${r.bundleId}, ${r.files} files, SDK ${sdkVersion()}). Next: harmony_build.` };
    } catch (err) {
      return { output: String(err), isError: true };
    }
  },
};
