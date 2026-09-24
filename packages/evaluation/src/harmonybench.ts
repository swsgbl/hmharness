/**
 * @hmharness/evaluation - HarmonyBench v1 (P0-04, 2026-09-24 audit)
 *
 * The formal benchmark: 50+ versioned cases across 6 categories, with
 * release baseline tracking, regression detection, and formal scoring.
 * This upgrades the internal bench tool to the "正式 Benchmark" the audit
 * demanded: "带 task manifest、fixture version、expected behavior、scoring、
 * environment lock、release baseline、regression set".
 */

export interface BenchCase {
  /** unique case id: category-NNN */
  id: string;
  /** the task prompt */
  prompt: string;
  /** expected behavior description */
  expected: string;
  /** assertion: what the output must contain/match */
  assertion: { type: 'exact' | 'contains' | 'not_contains' | 'regex'; value: string };
  /** category for reporting */
  category: BenchCategory;
  /** case difficulty (1=easy, 2=medium, 3=hard) */
  difficulty: 1 | 2 | 3;
  /** minimum turns expected (efficiency signal) */
  expectedTurns: number;
  /** whether this case requires tools */
  needsTools: boolean;
}

export type BenchCategory = 'exactness' | 'cjk' | 'code' | 'reasoning' | 'tools' | 'harmony';

export interface BenchResult {
  caseId: string;
  category: BenchCategory;
  pass: boolean;
  output: string;
  turns: number;
  tokens: number;
  durationMs: number;
}

export interface BenchReport {
  /** benchmark version (fixture governance) */
  benchVersion: string;
  /** hmh version that produced this report */
  hmhVersion: string;
  timestamp: string;
  total: number;
  passed: number;
  passRate: number;
  byCategory: Record<BenchCategory, { total: number; passed: number; rate: number }>;
  regressionVsBaseline?: Array<{ caseId: string; was: 'pass'; now: 'fail' }>;
  results: BenchResult[];
}

/**
 * HarmonyBench v1.0.0 - 54 cases across 6 categories.
 * Version-locked: any change to cases requires a version bump.
 */
export const HARMONYBENCH_VERSION = '1.0.0';

export const HARMONYBENCH_CASES: BenchCase[] = [
  // ===== EXACTNESS (10) =====
  { id: 'exact-001', prompt: 'reply with exactly: HELLO', expected: 'exact string HELLO', assertion: { type: 'exact', value: 'HELLO' }, category: 'exactness', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'exact-002', prompt: 'reply with exactly: 42', expected: 'exact string 42', assertion: { type: 'exact', value: '42' }, category: 'exactness', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'exact-003', prompt: 'reply with exactly: {"ok":true}', expected: 'exact JSON', assertion: { type: 'exact', value: '{"ok":true}' }, category: 'exactness', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'exact-004', prompt: 'reply with exactly: 3.14159', expected: 'exact number', assertion: { type: 'exact', value: '3.14159' }, category: 'exactness', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'exact-005', prompt: 'reply with exactly: A', expected: 'single letter', assertion: { type: 'exact', value: 'A' }, category: 'exactness', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'exact-006', prompt: 'reply with exactly: done', expected: 'lowercase done', assertion: { type: 'exact', value: 'done' }, category: 'exactness', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'exact-007', prompt: 'reply with exactly: null', expected: 'null literal', assertion: { type: 'exact', value: 'null' }, category: 'exactness', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'exact-008', prompt: 'reply with exactly: true', expected: 'boolean true', assertion: { type: 'exact', value: 'true' }, category: 'exactness', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'exact-009', prompt: 'reply with exactly: [1,2,3]', expected: 'array literal', assertion: { type: 'exact', value: '[1,2,3]' }, category: 'exactness', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'exact-010', prompt: 'reply with exactly: OK-DONE', expected: 'hyphenated', assertion: { type: 'exact', value: 'OK-DONE' }, category: 'exactness', difficulty: 1, expectedTurns: 1, needsTools: false },

  // ===== CJK / Chinese (10) =====
  { id: 'cjk-001', prompt: '用中文回答：1+1等于几？只输出数字', expected: 'Chinese digit 2', assertion: { type: 'regex', value: '2|二' }, category: 'cjk', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'cjk-002', prompt: '把"hello"翻译成中文，只输出翻译结果', expected: '你好', assertion: { type: 'contains', value: '你好' }, category: 'cjk', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'cjk-003', prompt: '把"世界"翻译成英文，只输出翻译结果', expected: 'world', assertion: { type: 'contains', value: 'world' }, category: 'cjk', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'cjk-004', prompt: '用不超过10个汉字解释什么是JSON', expected: 'short Chinese explanation', assertion: { type: 'regex', value: '[\\u4e00-\\u9fff]{2,10}' }, category: 'cjk', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'cjk-005', prompt: '用不超过10个汉字解释什么是API', expected: 'short Chinese explanation', assertion: { type: 'regex', value: '[\\u4e00-\\u9fff]{2,10}' }, category: 'cjk', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'cjk-006', prompt: '列出3个编程语言，逗号分隔，不要其他内容', expected: '3 languages', assertion: { type: 'regex', value: '\\w+,\\s*\\w+,\\s*\\w+' }, category: 'cjk', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'cjk-007', prompt: '用中文写一句关于春天的诗，不要解释', expected: 'Chinese poem line', assertion: { type: 'regex', value: '[\\u4e00-\\u9fff]{4,}' }, category: 'cjk', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'cjk-008', prompt: '把"开源改变世界"翻译成英文，只输出翻译', expected: 'Open source changes the world', assertion: { type: 'regex', value: '(?i)open.?source' }, category: 'cjk', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'cjk-009', prompt: '一年有多少天？只输出数字', expected: '365', assertion: { type: 'contains', value: '365' }, category: 'cjk', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'cjk-010', prompt: '列出3个欧洲国家，逗号分隔，不要其他内容', expected: '3 European countries', assertion: { type: 'regex', value: '\\w+,\\s*\\w+,\\s*\\w+' }, category: 'cjk', difficulty: 1, expectedTurns: 1, needsTools: false },

  // ===== CODE (10) =====
  { id: 'code-001', prompt: '写一个Python函数 is_palindrome(s)，判断回文，只输出代码', expected: 'Python function', assertion: { type: 'contains', value: 'def is_palindrome' }, category: 'code', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'code-002', prompt: '写一个JavaScript函数 sum(arr)，返回数组和，只输出代码', expected: 'JS function', assertion: { type: 'contains', value: 'function sum' }, category: 'code', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'code-003', prompt: '写一个SQL查询：从users表选取age>18的name，只输出SQL', expected: 'SELECT statement', assertion: { type: 'regex', value: '(?i)SELECT.*FROM.*users.*WHERE.*age' }, category: 'code', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'code-004', prompt: '用正则表达式匹配中国大陆手机号（1开头11位），只输出正则', expected: 'phone regex', assertion: { type: 'contains', value: '1' }, category: 'code', difficulty: 3, expectedTurns: 1, needsTools: false },
  { id: 'code-005', prompt: '写一个Bash命令：列出当前目录下所有.ts文件，只输出命令', expected: 'find/ls command', assertion: { type: 'regex', value: '(find|ls).*\\.ts' }, category: 'code', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'code-006', prompt: '写一个 TypeScript interface User，包含 name:string 和 age:number，只输出代码', expected: 'TS interface', assertion: { type: 'contains', value: 'interface User' }, category: 'code', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'code-007', prompt: '写一个 Python 列表推导式：生成1到10的平方数列表，只输出代码', expected: 'list comprehension', assertion: { type: 'contains', value: '**2' }, category: 'code', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'code-008', prompt: '写一个 Git 命令：撤销最后一次 commit 但保留更改，只输出命令', expected: 'git reset --soft', assertion: { type: 'contains', value: 'reset' }, category: 'code', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'code-009', prompt: '把 JSON {"a":1} 压缩成一行，只输出结果', expected: 'compressed JSON', assertion: { type: 'exact', value: '{"a":1}' }, category: 'code', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'code-010', prompt: '写一个 CSS 规则：将文字颜色设为红色，只输出CSS', expected: 'color: red', assertion: { type: 'regex', value: 'color:\\s*red' }, category: 'code', difficulty: 1, expectedTurns: 1, needsTools: false },

  // ===== REASONING (8) =====
  { id: 'reason-001', prompt: '一个矩形长12宽8，求面积和周长。格式：面积=X 周长=Y', expected: '面积=96 周长=40', assertion: { type: 'contains', value: '96' }, category: 'reasoning', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'reason-002', prompt: '1到100的和是多少？只输出数字', expected: '5050', assertion: { type: 'contains', value: '5050' }, category: 'reasoning', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'reason-003', prompt: '二分查找的时间复杂度是什么？只输出大O表示', expected: 'O(log n)', assertion: { type: 'regex', value: 'O\\(.*log' }, category: 'reasoning', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'reason-004', prompt: '17+25等于多少？只输出数字', expected: '42', assertion: { type: 'contains', value: '42' }, category: 'reasoning', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'reason-005', prompt: '100除以4等于多少？只输出数字', expected: '25', assertion: { type: 'contains', value: '25' }, category: 'reasoning', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'reason-006', prompt: '7乘以8等于多少？只输出数字', expected: '56', assertion: { type: 'contains', value: '56' }, category: 'reasoning', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'reason-007', prompt: '50减去23等于多少？只输出数字', expected: '27', assertion: { type: 'contains', value: '27' }, category: 'reasoning', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'reason-008', prompt: '把 "hello world foo bar" 按空格分割，输出数组，只输出结果', expected: 'array of 4 strings', assertion: { type: 'regex', value: 'hello.*world.*foo.*bar' }, category: 'reasoning', difficulty: 2, expectedTurns: 1, needsTools: false },

  // ===== TOOLS (8) =====
  { id: 'tool-001', prompt: '读取 package.json 文件并告诉我 name 字段的值', expected: 'reads file and extracts name', assertion: { type: 'regex', value: 'hmharness|name' }, category: 'tools', difficulty: 2, expectedTurns: 3, needsTools: true },
  { id: 'tool-002', prompt: '列出当前目录下的所有文件', expected: 'uses list_directory tool', assertion: { type: 'regex', value: '.+' }, category: 'tools', difficulty: 1, expectedTurns: 2, needsTools: true },
  { id: 'tool-003', prompt: '检查 package.json 的 version 字段', expected: 'reads and reports version', assertion: { type: 'regex', value: '\\d+\\.\\d+' }, category: 'tools', difficulty: 2, expectedTurns: 3, needsTools: true },
  { id: 'tool-004', prompt: '创建一个文件 test-output.txt 内容为 "bench test"，然后读回来验证', expected: 'writes and reads back', assertion: { type: 'contains', value: 'bench test' }, category: 'tools', difficulty: 2, expectedTurns: 4, needsTools: true },
  { id: 'tool-005', prompt: '运行 echo hello 并返回输出', expected: 'executes command', assertion: { type: 'contains', value: 'hello' }, category: 'tools', difficulty: 2, expectedTurns: 3, needsTools: true },
  { id: 'tool-006', prompt: '搜索代码中的 "function" 关键词', expected: 'searches code', assertion: { type: 'regex', value: '.+' }, category: 'tools', difficulty: 2, expectedTurns: 3, needsTools: true },
  { id: 'tool-007', prompt: '读取 tsconfig.json 并报告 target 值', expected: 'reads config', assertion: { type: 'regex', value: '(?i)(es\\d+|target)' }, category: 'tools', difficulty: 2, expectedTurns: 3, needsTools: true },
  { id: 'tool-008', prompt: '获取当前工作目录路径', expected: 'returns cwd', assertion: { type: 'regex', value: '[A-Z]:|/' }, category: 'tools', difficulty: 1, expectedTurns: 2, needsTools: true },

  // ===== HARMONY (8) =====
  { id: 'harm-001', prompt: '什么是 HarmonyOS？用一句话回答', expected: 'describes HarmonyOS', assertion: { type: 'contains', value: 'HarmonyOS' }, category: 'harmony', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'harm-002', prompt: 'ArkTS 和 TypeScript 的关系是什么？用一句话回答', expected: 'superset/extension relationship', assertion: { type: 'regex', value: '(?i)(扩展|超集|superset|extension|基于)' }, category: 'harmony', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'harm-003', prompt: '写出鸿蒙 UIAbility 的生命周期回调名称，逗号分隔', expected: 'lifecycle callbacks', assertion: { type: 'regex', value: 'onCreate' }, category: 'harmony', difficulty: 3, expectedTurns: 1, needsTools: false },
  { id: 'harm-004', prompt: '什么是 Stage 模型？用一句话回答', expected: 'describes Stage model', assertion: { type: 'regex', value: '(?i)(stage|模型|model)' }, category: 'harmony', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'harm-005', prompt: 'DevEco Studio 是什么？用一句话回答', expected: 'IDE description', assertion: { type: 'regex', value: '(?i)(IDE|开发|develop)' }, category: 'harmony', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'harm-006', prompt: 'hdc 是什么工具？用一句话回答', expected: 'device connector', assertion: { type: 'regex', value: '(?i)(设备|device|调试|debug|连接)' }, category: 'harmony', difficulty: 1, expectedTurns: 1, needsTools: false },
  { id: 'harm-007', prompt: 'ArkUI 使用什么声明式语法？只输出语法名称', expected: 'declarative UI', assertion: { type: 'regex', value: '(?i)(declar|声明)' }, category: 'harmony', difficulty: 2, expectedTurns: 1, needsTools: false },
  { id: 'harm-008', prompt: 'HAP 是什么文件格式？用一句话回答', expected: 'Harmony Application Package', assertion: { type: 'regex', value: '(?i)(包|package|应用|app)' }, category: 'harmony', difficulty: 1, expectedTurns: 1, needsTools: false },
];

/**
 * Run a single assertion against model output.
 * Pure - testable.
 */
export function checkAssertion(output: string, assertion: BenchCase['assertion']): boolean {
  const trimmed = output.trim();
  switch (assertion.type) {
    case 'exact':
      return trimmed === assertion.value;
    case 'contains':
      return trimmed.includes(assertion.value);
    case 'not_contains':
      return !trimmed.includes(assertion.value);
    case 'regex':
      try { return new RegExp(assertion.value, 'i').test(trimmed); }
      catch { return trimmed.includes(assertion.value); }
    default:
      return false;
  }
}

/**
 * Build the by-category summary from individual results.
 * Pure - testable.
 */
export function summarizeByCategory(results: Array<{ caseId: string; category: BenchCategory; pass: boolean }>): Record<BenchCategory, { total: number; passed: number; rate: number }> {
  const cats: BenchCategory[] = ['exactness', 'cjk', 'code', 'reasoning', 'tools', 'harmony'];
  const out = {} as Record<BenchCategory, { total: number; passed: number; rate: number }>;
  for (const c of cats) {
    const rows = results.filter(r => r.category === c);
    const passed = rows.filter(r => r.pass).length;
    out[c] = { total: rows.length, passed, rate: rows.length ? passed / rows.length : 0 };
  }
  return out;
}

/**
 * Detect regressions vs a baseline report.
 * Pure - testable.
 */
export function detectRegressions(current: Array<{ caseId: string; pass: boolean }>, baseline: Array<{ caseId: string; pass: boolean }>): Array<{ caseId: string; was: 'pass'; now: 'fail' }> {
  const baseMap = new Map(baseline.map(r => [r.caseId, r.pass]));
  return current
    .filter(r => !r.pass && baseMap.get(r.caseId) === true)
    .map(r => ({ caseId: r.caseId, was: 'pass' as const, now: 'fail' as const }));
}

/**
 * Validate the benchmark suite itself (fixture governance).
 * Every case must have: unique id, non-empty prompt, valid assertion,
 * valid category, valid difficulty.
 */
export function validateBenchSuite(cases: BenchCase[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) errors.push(`duplicate id: ${c.id}`);
    ids.add(c.id);
    if (!c.prompt.trim()) errors.push(`empty prompt: ${c.id}`);
    if (!c.assertion.value) errors.push(`empty assertion: ${c.id}`);
    if (!['exact', 'contains', 'not_contains', 'regex'].includes(c.assertion.type)) errors.push(`invalid assertion type: ${c.id}`);
    if (![1, 2, 3].includes(c.difficulty)) errors.push(`invalid difficulty: ${c.id}`);
  }
  if (cases.length < 50) errors.push(`only ${cases.length} cases, need >=50 for HarmonyBench v1`);
  return { valid: errors.length === 0, errors };
}
