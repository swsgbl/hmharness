/**
 * @hmharness/web - page (P1-3 split assembler)
 * 原单文件 page.ts(3832 行,2026-10 拆分)按交互域切出到 page/*.ts,本文件
 * 只剩装配:按页面原始顺序拼接各域片段。红线:最终 PAGE 与拆分前逐字节一致
 * (拆分期守门脚本 tmp-check),不改任何 DOM/类名/交互/wire 协议。
 * 唯一模板洞:uiLiteSource()(uilite.ts 纯函数内联,2026-10-07 教训——新
 * 函数必须登记 uiLiteSource() 的清单,否则页面拿不到)。
 * 域间 '\n' 补的是原文的分隔空行(各域片段尾部已带自身行尾换行);
 * SSE 紧接 DOCK 无空行,维持原样。
 * 模板字面量规则(各域同):无裸反引号,页面 JS 内不用插值(字符串拼接),
 * 正则反斜杠双写。
 */
import { uiLiteSource } from './uilite.ts';
import { HEAD } from './page/head.ts';
import { BODY } from './page/body.ts';
import { CORE } from './page/core.ts';
import { WORKSPACES } from './page/workspaces.ts';
import { VIEWS } from './page/views.ts';
import { SETTINGS } from './page/settings.ts';
import { SESSIONS } from './page/sessions.ts';
import { DOCK } from './page/dock.ts';
import { SSE } from './page/sse.ts';
import { CHROME } from './page/chrome.ts';
import { COMPOSER } from './page/composer.ts';
import { SHELL } from './page/shell.ts';

export const PAGE =
  HEAD +
  BODY +
  uiLiteSource() + '\n' +
  CORE + '\n' +
  WORKSPACES + '\n' +
  VIEWS + '\n' +
  SETTINGS + '\n' +
  SESSIONS + '\n' +
  DOCK +
  SSE + '\n' +
  CHROME + '\n' +
  COMPOSER + '\n' +
  SHELL +
  '</script>\n</body>\n</html>\n';
