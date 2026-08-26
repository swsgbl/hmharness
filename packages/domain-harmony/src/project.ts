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

export interface ScaffoldModule {
  name: string;
  type?: 'feature' | 'har';
}

export interface ScaffoldOptions {
  name?: string;
  bundleId?: string;
  /** Extra pages beyond Index (PascalCase identifiers). */
  pages?: string[];
  /** Extra modules: feature HAPs or har libraries. */
  modules?: ScaffoldModule[];
}

const IDENT = /^[A-Z][A-Za-z0-9]*$/;

export async function scaffoldProject(dir: string, opts: ScaffoldOptions = {}): Promise<{ root: string; bundleId: string; files: number }> {
  const root = resolve(dir);
  const name = opts.name ?? basename(root);
  const bundleId = opts.bundleId ?? `com.example.${sanitizeIdent(name)}`;
  const sdk = sdkVersion();
  const pages = ['Index', ...(opts.pages ?? []).map((p) => String(p).trim()).filter((p) => IDENT.test(p))];
  const modules = (opts.modules ?? [])
    .map((m) => ({ name: sanitizeIdent(m.name).replace(/-/g, ''), type: m.type === 'har' ? ('har' as const) : ('feature' as const) }))
    .filter((m) => m.name.length > 0 && m.name !== 'entry');
  const harNames = modules.filter((m) => m.type === 'har').map((m) => m.name);
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
    ...modules.map(
      (m) => [
        '    ,{',
        `      "name": "${m.name}",`,
        `      "srcPath": "./${m.name}",`,
        '      "targets": [',
        '        {',
        '          "name": "default",',
        '          "applyToProducts": [ "default" ]',
        '        }',
        '      ]',
        '    }',
      ].join('\n'),
    ),
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

  files += await W(
    'entry/oh-package.json5',
    [
      '{',
      '  "name": "entry",',
      '  "version": "1.0.0",',
      '  "description": "entry module",',
      harNames.length > 0
        ? '  "dependencies": {\n' + harNames.map((h) => `    "${h}": "file:../${h}"`).join(',\n') + '\n  }'
        : '  "dependencies": {}',
      '}',
      '',
    ].join('\n'),
  );
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
  files += await W(
    'entry/src/main/resources/base/profile/main_pages.json',
    ['{', '  "src": [', ...pages.map((p) => `    "pages/${p}"${p === pages[pages.length - 1] ? '' : ','}`), '  ]', '}', ''].join('\n'),
  );
  // extra pages beyond Index
  for (const p of pages.slice(1)) {
    files += await W(
      `entry/src/main/ets/pages/${p}.ets`,
      [
        '@Entry',
        '@Component',
        `struct ${p} {`,
        '  build() {',
        '    Column() {',
        `      Text('${p}')`,
        '        .fontSize(32)',
        '        .fontWeight(FontWeight.Bold)',
        '    }',
        "    .width('100%')",
        "    .height('100%')",
        '    .justifyContent(FlexAlign.Center)',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  }

  // extra modules (feature HAPs / har libraries)
  for (const m of modules) {
    const task = m.type === 'har' ? 'harTasks' : 'hapTasks';
    files += await W(
      `${m.name}/hvigorfile.ts`,
      [
        `import { ${task} } from '@ohos/hvigor-ohos-plugin';`,
        '',
        'export default {',
        `  system: ${task},`,
        '  plugins: []',
        '}',
        '',
      ].join('\n'),
    );
    files += await W(`${m.name}/oh-package.json5`, ['{', `  "name": "${m.name}",`, '  "version": "1.0.0",', `  "description": "${m.type} module",`, '  "main": "Index.ets",', '  "dependencies": {}', '}', ''].join('\n'));
    files += await W(`${m.name}/build-profile.json5`, ['{', '  "apiType": "stageMode",', '  "buildOption": {},', '  "targets": [', '    { "name": "default" }', '  ]', '}', ''].join('\n'));
    files += await W(
      `${m.name}/src/main/module.json5`,
      [
        '{',
        '  "module": {',
        `    "name": "${m.name}",`,
        `    "type": "${m.type}",`,
        `    "description": "$string:module_desc",`,
        '    "deviceTypes": [ "phone", "tablet", "2in1" ],',
        '    "deliveryWithInstall": true',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    if (m.type === 'har') {
      files += await W(
        `${m.name}/src/main/ets/Index.ets`,
        [`export const ${m.name.toUpperCase()}_VERSION = '1.0.0';`, '', `export function ${m.name}Hello(): string {`, `  return 'hello from ${m.name}';`, '}', ''].join('\n'),
      );
    } else {
      files += await W(
        `${m.name}/src/main/ets/${m.name}Api.ets`,
        [`export const ${m.name.toUpperCase()}_LOADED = true;`, ''].join('\n'),
      );
    }
    files += await W(
      `${m.name}/src/main/resources/base/element/string.json`,
      ['{', '  "string": [', '    { "name": "module_desc", "value": "' + m.type + ' module ' + m.name + '" }', '  ]', '}', ''].join('\n'),
    );
  }

  return { root, bundleId, files };
}

export const harmonyProjectCreate: Tool = {
  name: 'harmony_project_create',
  description:
    'Scaffold a buildable HarmonyOS project (stage model, ArkTS) - fully parametric, no DevEco IDE needed. Options: extra pages (PascalCase, e.g. ["Login","Home"] - each gets a routable page file and main_pages registration) and extra modules (e.g. [{"name":"profile","type":"feature"}] HAP-in-app, or [{"name":"uikit","type":"har"}] shared library wired into entry dependencies). Any project shape in one call, then harmony_build. Requires approval (writes files).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'directory to create the project in (created if missing)' },
      name: { type: 'string', description: 'display name (default: directory basename)' },
      bundle_id: { type: 'string', description: 'bundle name (default: com.example.<name>)' },
      pages: { type: 'array', items: { type: 'string' }, description: 'extra page names beyond Index, PascalCase' },
      modules: {
        type: 'array',
        description: 'extra modules; default type is feature',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'module name (letters/digits)' },
            type: { type: 'string', description: '"feature" (in-app HAP) or "har" (shared library)' },
          },
          required: ['name'],
        },
      },
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
        pages: Array.isArray(args.pages) ? (args.pages as unknown as string[]) : undefined,
        modules: Array.isArray(args.modules) ? (args.modules as unknown as ScaffoldModule[]) : undefined,
      });
      return { output: `created project at ${r.root} (bundle ${r.bundleId}, ${r.files} files, SDK ${sdkVersion()}). Next: harmony_build.` };
    } catch (err) {
      return { output: String(err), isError: true };
    }
  },
};
