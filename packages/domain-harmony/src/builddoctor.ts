/**
 * @hmh/domain-harmony - builddoctor (compile-fix loop, the codelin icf gap)
 * When hvigor fails, its log is a wall of stack traces. This tool parses
 * the failure into ONE OF A SMALL SET OF KNOWN CAUSE CLASSES and returns
 * the concrete fix for that class - so the agent (or user) repairs the
 * actual cause instead of googling the tail of a stack trace.
 *
 * The classifier is deliberately regex-on-tail: hvigor's stable failure
 * signatures are few (env/sdk/signing/deps/arkts/config), each with a
 * known remedy. Unknown signatures pass through with the raw tail so
 * nothing is hidden.
 */
import type { Tool } from '@hmh/kernel';

export interface DiagnosedError {
  kind: string;
  fix: string;
  evidence: string;
}

/** Cause classes: signature -> fix. Order matters (first hit wins). */
const SIGNATURES: Array<{ re: RegExp; kind: string; fix: string }> = [
  {
    re: /Invalid value of DEVECO_SDK_HOME|sdk home|not find sdk|SdkHomePath/i,
    kind: 'sdk-home',
    fix: 'DEVECO_SDK_HOME is unset or wrong. Set HM_DEVECO_HOME (default C:\\DevEco-Studio) or export DEVECO_SDK_HOME=<DevEco>/sdk; our build wrapper already tries - set HM_DEVECO_HOME and retry.',
  },
  {
    re: /signingConfigs|signing config|keystore|\.p12|\.cer|no signing/i,
    kind: 'signing',
    fix: 'Signing config missing/invalid. For a debug run on emulator this is usually a stale auto-signature: in DevEco re-enable auto-sign (File > Project Structure > Signing), or clear signingConfigs and build unsigned for install checks. Production signing needs real certs from AppGallery.',
  },
  {
    re: /ohpm (install|ERROR)|ohos_modules|Failed to install dependencies|ERESOLVE|404 .*ohpm/i,
    kind: 'ohpm-deps',
    fix: 'ohpm dependency resolution failed. Run: ohpm install --all (in the project root) and check oh-package.json5 versions actually exist on the registry; .har file: deps must exist or be pre-built.',
  },
  {
    re: /hvigor (daemon|wrapper)|node: not found|NODE_HOME|Cannot find module .*hvigor/i,
    kind: 'hvigor-env',
    fix: 'hvigor/node environment broken. Set HM_DEVECO_HOME so the bundled tools/node is found; delete the project .hvigor cache dir and retry (a corrupted daemon cache is common).',
  },
  {
    re: /ERROR: ArkTS|arkts-\d+|Cannot find module '@|Struct.*must|expected component/i,
    kind: 'arkts-source',
    fix: 'ArkTS compile error (source). Open the file+line named in the log above this diagnosis; the fix is a code edit (missing import, wrong type, struct syntax) - not an environment issue. Read the first "ERROR" block for the exact location.',
  },
  {
    re: /build-profile|module.json5|parse.*json|Expected.*json|module.*not found in/i,
    kind: 'config',
    fix: 'Project config problem. Run harmony_schema_check first - it names the exact broken field in module.json5/build-profile.json5 in milliseconds instead of this stack trace.',
  },
  {
    re: /network|ECONN|timeout|registry|fetch failed/i,
    kind: 'network',
    fix: 'Network failure fetching deps/registry. Check proxy (or disable proxy for 127.0.0.1 registries) and retry; ohpm may need a mirror (ohpm config set registry https://ohpm.openharmony.cn/ohpm/).',
  },
];

/** Diagnose a hvigor/build failure output; unknown returns null (caller
 *  shows the raw tail - never hide unclassified failures). */
export function diagnoseBuildFailure(log: string): DiagnosedError | null {
  // the interesting part is the LAST error block, not the whole log
  const tail = log.slice(-8000);
  for (const s of SIGNATURES) {
    const m = tail.match(s.re);
    if (m) {
      const evidence = tail.split('\n').find((l) => s.re.test(l))?.trim().slice(0, 200) ?? m[0];
      return { kind: s.kind, fix: s.fix, evidence };
    }
  }
  return null;
}

/** Extract the first ERROR block (file/line/position) from a build log. */
export function firstErrorBlock(log: string): string {
  const i = log.search(/^.*\bERROR\b/m);
  if (i < 0) return '';
  return log.slice(i, i + 700).split('\n').slice(0, 8).join('\n');
}

export const harmonyBuildDoctor: Tool = {
  name: 'harmony_build_doctor',
  description:
    'Diagnose a failed HarmonyOS build log: classifies the failure into a known cause class (sdk-home / signing / ohpm-deps / hvigor-env / arkts-source / config / network) and returns the concrete fix for that class plus the first ERROR block. Pass the build output text; also runs harmony_build yourself and diagnoses when given a project path with run=true.',
  parameters: {
    type: 'object',
    properties: {
      log: { type: 'string', description: 'the failed build output to diagnose (from a previous harmony_build)' },
      project: { type: 'string', description: 'alternative: run harmony_build on this path now and diagnose its output' },
    },
    required: [],
  },
  needsApproval: () => false,
  async execute(args, ctx) {
    let log = typeof args.log === 'string' ? args.log : '';
    if (!log && typeof args.project === 'string') {
      const { harmonyBuild } = await import('./index.ts');
      const r = await harmonyBuild.execute({ project: args.project }, ctx);
      log = r.output;
      if (!r.isError) return { output: `build succeeded - nothing to diagnose.\n${log.split('\n').slice(0, 3).join('\n')}` };
    }
    if (!log.trim()) return { output: 'pass the failed build output in `log`, or a project path to run a fresh build.', isError: true };
    const d = diagnoseBuildFailure(log);
    const first = firstErrorBlock(log);
    if (!d) {
      return { output: `Unclassified failure (no known signature matched) - full context follows. If a pattern repeats, it belongs in the doctor's signature table.\n\nFirst ERROR block:\n${first || '(none found)'}\n\nTail:\n${log.slice(-1200)}` };
    }
    return {
      output: [
        `kind: ${d.kind}`,
        `evidence: ${d.evidence}`,
        `fix: ${d.fix}`,
        '',
        'First ERROR block:',
        first || '(no explicit ERROR line - see evidence above)',
      ].join('\n'),
    };
  },
};
