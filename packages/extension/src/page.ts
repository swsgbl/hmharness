/**
 * @hmharness/extension - page snapshot normalization (Node side)
 *
 * The DOM-facing collector (collectPageData in extension/background.js)
 * must stay a self-contained injected function, so it lives in the
 * browser. Everything that NORMALIZES raw page data — dedup, caps,
 * outline formatting, agent-facing text shape — lives HERE, where it is
 * unit-testable without a DOM. Honest coarseness: the outline is a
 * heuristic (headings + visible links), never claimed to be a full
 * accessibility tree like the CDP snapshot in @hmharness/browser.
 */
import type { PageSnapshot, RawPageData } from './protocol.ts';

const MAX_OUTLINE = 80;
const MAX_LINKS = 80;
const MAX_INPUTS = 40;
const MAX_TEXT = 8_000;

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
};

/** Raw collector output -> the agent-facing snapshot. Pure; no DOM. */
export function summarizePage(raw: RawPageData): PageSnapshot {
  const outline: string[] = [];
  let outlineCut = false;
  for (const h of raw.headings ?? []) {
    if (outline.length >= MAX_OUTLINE) { outlineCut = true; break; }
    const text = clip(h?.text, 160);
    if (!text) continue;
    const level = Math.max(1, Math.min(6, h?.level ?? 1));
    outline.push(`${'  '.repeat(level - 1)}${'#'.repeat(level)} ${text}`);
  }
  // dedupe links by href, keep display order, drop non-http(s)
  const seen = new Set<string>();
  const links: string[] = [];
  let linksCut = false;
  for (const l of raw.links ?? []) {
    if (links.length >= MAX_LINKS) { linksCut = true; break; }
    const href = clip(l?.href, 300);
    if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
    seen.add(href);
    links.push(`${clip(l?.text, 80)} → ${href}`);
  }
  const rawInputs = raw.inputs ?? [];
  const inputs = rawInputs.slice(0, MAX_INPUTS).map((i) =>
    `${clip(i?.tag, 12)}[${clip(i?.type, 12)}]${i?.name ? ` name=${clip(i.name, 80)}` : ''}${i?.placeholder ? ` ph="${clip(i.placeholder, 60)}"` : ''}`,
  );
  const text = clip(raw.text, MAX_TEXT);
  return {
    url: clip(raw.url, 2_000),
    title: clip(raw.title, 300),
    selection: clip(raw.selection, 800),
    outline,
    links,
    inputs,
    text,
    truncated: (raw.text?.length ?? 0) > MAX_TEXT || outlineCut || linksCut || rawInputs.length > MAX_INPUTS,
  };
}

/** Agent-facing text rendering (mirrors @hmharness/browser's read output shape). */
export function formatPageSnapshot(s: PageSnapshot): string {
  const parts: string[] = [s.title || '(无标题)', s.url];
  if (s.selection) parts.push(`\n[用户选区] ${s.selection}`);
  if (s.outline.length > 0) parts.push('\n[大纲]\n' + s.outline.join('\n'));
  if (s.inputs.length > 0) parts.push('\n[表单]\n' + s.inputs.map((i) => '  ' + i).join('\n'));
  if (s.links.length > 0) parts.push(`\n[链接 ${s.links.length}]\n` + s.links.slice(0, 40).map((l) => '  ' + l).join('\n') + (s.links.length > 40 ? `\n  …共 ${s.links.length} 条` : ''));
  parts.push(`\n[正文]${s.truncated ? '（截断）' : ''}\n${s.text || '(无正文)'}`);
  return parts.join('\n');
}
