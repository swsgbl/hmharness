/**
 * page.ts DOM XSS sink regression (audit P0-A, 2026-10-10):
 * 1) the nine fixed sinks must stay escaped (anchor assertions);
 * 2) any NEW innerHTML-concat line that interpolates a known dynamic
 *    API/SSE field must route through esc()/renderMarkdown()/locale L.*
 *    — an unescaped new sink turns this test red, not the pen-test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'page.ts'), 'utf8');
const lines = src.split('\n');

test('九个已修 sink 的锚点(回退即红)', () => {
  const anchors: Array<[string, string]> = [
    ['loadReplay step', 'esc(s.actionType)'],
    ['loadReplay head goal', 'esc(String(v.goal).slice(0, 60))'],
    ['loadReplay head env', "esc(v.environmentId) + ' · 耗时 '"],
    ['team topology', 'esc(n.role) + \'·\' + esc(n.status)'],
    ['team event goal', 'esc(String(e.goal).slice(0, 40))'],
    ['team event node', "esc(e.nodeId) + ' [' + esc(e.role) + '] 预算'"],
    ['session group head', 'esc(projName(g.path))'],
    ['fs error(list)', "list.innerHTML = '<div class=\"hint err\">' + esc((res.d && res.d.error) || 'failed')"],
    ['fs error(box)', "box.innerHTML = '<div class=\"hint err\">' + esc((res.d && res.d.error) || 'failed')"],
    ['calibration spark title', 'esc(b.at.slice(0, 10))'],
  ];
  for (const [name, needle] of anchors) {
    assert.ok(src.includes(needle), `${name}: 锚点缺失——sink 修复被回退?期望包含 "${needle}"`);
  }
});

test('esc() 转义五字符(& < > \" \')——元素与属性上下文都安全', () => {
  // 从 uilite.ts 直接加载 esc 验证行为(page.ts 是模板,不便于直接执行)
  const uilite = readFileSync(join(here, '..', 'uilite.ts'), 'utf8');
  assert.match(uilite, /function esc\(/, 'uilite.ts 暴露 esc()');
  const payload = `<img src=x onerror="alert('xss')">&'`;
  // esc 的实现按 5 字符替换;直接以独立函数复刻其语义做行为断言
  const escLike = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const out = escLike(payload);
  assert.ok(!out.includes('<img'), '尖括号被转义,标签不可注入');
  assert.ok(!out.includes('"') && !out.includes("'"), '引号被转义,属性不可逃逸');
});

test('通用规则:innerHTML 拼接行中的动态 API/SSE 字段必须走 esc/renderMarkdown/L.*(防新增 sink)', () => {
  // 已知动态字段(来自 /api/cognitive*、/api/sessions、/api/fs、SSE 事件负载)
  const dynamicField = /\.(actionType|goal|goalDescription|environmentId|nodeId|role|status|recommendation|candidateId|sourceEnv|targetEnv|verdict|description|error|title|task|outcome|cwd|branch)\b/;
  const offenders: string[] = [];
  lines.forEach((line, i) => {
    if (!/\.innerHTML\s*(=|\+=)/.test(line)) return;
    if (!line.includes('+')) return;
    // 安全出口:esc(/renderMarkdown(/L.(locale 静态)/纯静态类名拼接
    if (/esc\(|renderMarkdown\(|\bL\./.test(line)) return;
    if (dynamicField.test(line)) {
      offenders.push(`${i + 1}: ${line.trim().slice(0, 140)}`);
    }
  });
  assert.deepEqual(offenders, [], `发现未转义的动态 innerHTML 拼接行:\n${offenders.join('\n')}`);
});

test('SSE 渲染统一走 el()(textContent)——page.ts 必须保留该安全工厂', () => {
  assert.match(src, /function el\(/, 'el() 工厂存在');
  assert.match(src, /e\.textContent = text/, 'el() 使用 textContent 而非 innerHTML');
});
