/**
 * @hmharness/web - uilite
 * Pure, DOM-free page logic (fuzzy file matching, unified-diff parsing,
 * mini-markdown rendering). Two consumers share this ONE source:
 *  1. node tests import the functions directly;
 *  2. page.ts inlines them into the single-file page via uiLiteSource()
 *     (Function#toString - the page must stay zero-dependency vanilla JS).
 * Constraint: every exported function must be self-contained ES5-ish JS —
 * no imports, no template literals, no arrow functions (they would break
 * the inline-source contract and the page's template-literal rules).
 */

/** Subsequence fuzzy matcher (codex-style @ file search). Returns -1 when the
 *  query does NOT occur as a subsequence, otherwise a score where higher =
 *  better: prefix hits and camelCase/separator boundary hits win, gaps cost. */
export function fuzzyMatchScore(query: string, text: string): number {
  var q = query.toLowerCase();
  var t = text.toLowerCase();
  if (!q) return 0;
  // exact substring is the ceiling
  var exact = t.indexOf(q);
  if (exact >= 0) return 1000 - exact;
  var qi = 0;
  var score = 0;
  var lastHit = -1;
  for (var i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      var bonus = 0;
      if (i === 0) bonus += 40;                       // start-of-string hit
      var prev = i > 0 ? t[i - 1] : '';
      if (prev === '/' || prev === '\\' || prev === '_' || prev === '-' || prev === '.') bonus += 20; // path/separator boundary
      if (prev >= 'a' && prev <= 'z' && text[i] >= 'A' && text[i] <= 'Z') bonus += 15;                  // camelCase boundary
      if (lastHit >= 0 && i === lastHit + 1) bonus += 5;                                               // adjacency
      score += 10 + bonus;
      lastHit = i;
      qi++;
    }
  }
  if (qi < q.length) return -1;
  // penalize long text so short file names win ties; prefer basename hits
  var base = text.replace(/\\/g, '/').split('/').pop() || '';
  var baseBonus = base.toLowerCase().indexOf(q) >= 0 ? 200 : 0;
  return score + baseBonus - Math.floor(text.length / 40);
}

/** Parse a unified diff into renderable segments. Pure, line-based: the
 *  page paints + green / - red / @@ gray / file lines dim. */
export interface DiffSegment { kind: 'file' | 'hunk' | 'add' | 'del' | 'ctx' | 'other'; text: string }
export function parseUnifiedDiff(text: string): DiffSegment[] {
  var lines = String(text).split(/\r?\n/);
  var out: DiffSegment[] = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.slice(0, 3) === '---' || l.slice(0, 3) === '+++' || /^diff --git/.test(l)) {
      out.push({ kind: 'file', text: l });
    } else if (l.slice(0, 2) === '@@' && /@@/.test(l.slice(2))) {
      out.push({ kind: 'hunk', text: l });
    } else if (l[0] === '+') {
      out.push({ kind: 'add', text: l });
    } else if (l[0] === '-') {
      out.push({ kind: 'del', text: l });
    } else if (l[0] === ' ') {
      out.push({ kind: 'ctx', text: l });
    } else {
      out.push({ kind: 'other', text: l });
    }
  }
  return out;
}

/** True when the text looks like a unified diff worth diff-rendering. */
export function looksLikeDiff(text: string): boolean {
  return /^(--- |\+\+\+ |diff --git )/m.test(String(text)) && /^@@[^@]*@@/m.test(String(text));
}

/** Extract a numbered-step plan from an answer (A6 plan card): consecutive
 *  lines matching /^\s*\d+[.)]\s+/ that start a run of >=2 steps. Returns the
 *  step texts (markdown-stripped, trimmed) or [] when there is no plan. */
export function extractPlan(text: string): string[] {
  const lines = String(text).split(/\r?\n/);
  const steps: string[] = [];
  for (const raw of lines) {
    const m = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
    if (m) {
      steps.push(m[1].trim());
    } else if (steps.length > 0 && raw.trim() !== '') {
      break; // a non-step line after the run ends the plan block
    }
  }
  return steps.length >= 2 ? steps : [];
}

/** Deliverables (A9): the file paths edit_file/write_file touched, in order,
 *  deduped, workspace-relative when possible. Input rows: {name, args}. */
export function extractDeliverables(tools: Array<{ name: string; args: Record<string, unknown> }>): string[] {
  const out: string[] = [];
  for (const t of tools) {
    if (t.name !== 'edit_file' && t.name !== 'write_file') continue;
    const p = typeof t.args.path === 'string' ? t.args.path.trim() : '';
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Tiny code tokenizer for fenced blocks (keywords/strings/comments/numbers).
 *  Pure line scanner — no regex back-reference minefields. ES5-ish on purpose
 *  (the inline-source contract: no arrows, no template literals). */
var TOK_KW = ' const let var function return if else for while import from export async await class new try catch throw type interface extends static void number string boolean true false null undefined switch case break continue default ';
function tokLine(line: string): string {
  var out = '';
  var i = 0;
  var N = line.length;
  while (i < N) {
    var ch = line.charAt(i);
    var nxt = i + 1 < N ? line.charAt(i + 1) : '';
    if (ch === '/' && nxt === '/') {
      var e = line.indexOf('\n', i); if (e < 0) e = N;
      out += '<span class="tok-c">' + line.slice(i, e) + '</span>';
      i = e;
    } else if (ch === '"' || ch === "'") {
      var q = ch; var j = i + 1; var body = '';
      while (j < N) {
        var c2 = line.charAt(j);
        if (c2 === '\\') { body += c2 + (line.charAt(j + 1) || ''); j += 2; continue; }
        if (c2 === q) break;
        body += c2; j++;
      }
      out += '<span class="tok-s">' + q + body + q + '</span>';
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(ch)) {
      var k = i; var word = '';
      while (k < N && /[A-Za-z0-9_$]/.test(line.charAt(k))) { word += line.charAt(k); k++; }
      out += TOK_KW.indexOf(' ' + word + ' ') >= 0 ? '<span class="tok-k">' + word + '</span>' : word;
      i = k;
    } else if (/[0-9]/.test(ch)) {
      var m2 = i; var num = '';
      while (m2 < N && /[0-9._]/.test(line.charAt(m2))) { num += line.charAt(m2); m2++; }
      out += '<span class="tok-n">' + num + '</span>';
      i = m2;
    } else { out += ch; i++; }
  }
  return out;
}

/** Mini-markdown -> HTML (zero deps, page-safe). Handles: fenced code blocks
 *  (with copy button class + token coloring), headings, bold/italic/inline
 *  code, unordered and ordered lists, pipes tables, links, paragraphs.
 *  HTML-escapes first. */
export function renderMarkdown(src: string): string {
  var text = String(src).replace(/\r\n/g, '\n');
  var esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // fenced code blocks first: ```lang ... ``` -> pre (verbatim, keep escapes)
  var fenceRe = /```([a-zA-Z0-9_+#-]*)\n?([\s\S]*?)```/g;
  var blocks: string[] = [];
  var last = 0;
  var m: RegExpExecArray | null;
  while ((m = fenceRe.exec(esc)) !== null) {
    blocks.push(esc.slice(last, m.index));
    var colored = m[2].split('\n').map(tokLine).join('\n');
    blocks.push('<div class="codeblk"><div class="codebar"><span>' + (m[1] || 'text') + '</span><button type="button" class="copy">copy</button></div><pre>' + colored + '</pre></div>');
    last = m.index + m[0].length;
  }
  blocks.push(esc.slice(last));
  var html = '';
  for (var b = 0; b < blocks.length; b++) {
    if (b % 2 === 1) { html += blocks[b]; continue; }
    html += renderInlineBlocks(blocks[b]);
  }
  return html;
}

function renderInlineBlocks(body: string): string {
  var lines = body.split('\n');
  var out = '';
  var i = 0;
  var inTable = false;
  var tableRows: string[] = [];
  function flushTable() {
    if (!tableRows.length) return;
    out += '<table><thead><tr>' + tableRows[0] + '</tr></thead><tbody>';
    for (var r = 1; r < tableRows.length; r++) out += '<tr>' + tableRows[r] + '</tr>';
    out += '</tbody></table>';
    tableRows = [];
  }
  while (i < lines.length) {
    var l = lines[i];
    var t = l.trim();
    // table: consecutive pipe rows (skip the |---| separator row)
    if (/^\|.*\|$/.test(t) && t.indexOf('|') !== t.lastIndexOf('|')) {
      var isSep = /^\|[\s:|-]+\|$/.test(t);
      if (isSep) { i++; continue; }   // separator row: never a dead-end line
      if (!inTable) inTable = true;
      var cells = t.slice(1, -1).split('|').map(function (c) { return c.trim(); });
      tableRows.push(cells.map(function (c) { return '<td>' + inlineMd(c) + '</td>'; }).join(''));
      i++;
      continue;
    }
    if (inTable) { flushTable(); inTable = false; }
    // headings
    var hm = /^(#{1,6})\s+(.*)$/.exec(t);
    if (hm && !/^#{7}/.test(t)) {
      var lvl = hm[1].length;
      out += '<h' + lvl + '>' + inlineMd(hm[2]) + '</h' + lvl + '>';
      i++;
      continue;
    }
    // unordered list
    var um = /^[-*+]\s+(.*)$/.exec(t);
    if (um) {
      out += '<ul><li>' + inlineMd(um[1]) + '</li>';
      i++;
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        out += '<li>' + inlineMd(lines[i].trim().replace(/^[-*+]\s+/, '')) + '</li>';
        i++;
      }
      out += '</ul>';
      continue;
    }
    // ordered list
    var om = /^\d+[.)]\s+(.*)$/.exec(t);
    if (om) {
      out += '<ol><li>' + inlineMd(om[1]) + '</li>';
      i++;
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        out += '<li>' + inlineMd(lines[i].trim().replace(/^\d+[.)]\s+/, '')) + '</li>';
        i++;
      }
      out += '</ol>';
      continue;
    }
    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { out += '<hr>'; i++; continue; }
    if (!t) { out += '<div class="md-p"></div>'; i++; continue; }
    // paragraph: consume until a blank or block start
    var para: string[] = [];
    while (i < lines.length) {
      var lt = lines[i].trim();
      if (!lt || /^(#{1,6})\s/.test(lt) || /^```/.test(lt) || /^\|.*\|$/.test(lt) || /^[-*+]\s+/.test(lt) || /^\d+[.)]\s+/.test(lt)) break;
      para.push(lines[i]);
      i++;
    }
    if (para.length) out += '<p>' + para.map(inlineMd).join('<br>') + '</p>';
    else i++; // unrecognized lone line (e.g. stray | row) — never dead-end
  }
  flushTable();
  return out;
}

/** Inline markdown: `code`, **bold**, *italic*, [label](url), autolinks.
 *  Link labels are parked in placeholders FIRST so the autolink pass cannot
 *  re-wrap the URL already rendered inside an href (double-anchor bug). */
function inlineMd(s: string): string {
  var links: Array<{ label: string; url: string }> = [];
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, function (_m, label, url) {
    links.push({ label: label, url: url });
    return '\u0001L' + (links.length - 1) + '\u0001';
  });
  s = s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\u0001L(\d+)\u0001/g, function (_m, idx) {
    var l = links[Number(idx)];
    return '<a href="' + l.url + '" target="_blank" rel="noopener">' + l.label + '</a>';
  });
  return s;
}

/** Label-queue display: bench tasks are English templates and the list
 *  often truncates them mid-sentence - translate by matching BOTH the full
 *  form and the truncated prefix, falling back to a generic action.
 *  Non-template (real user) tasks pass through untouched. */
export function zhTask(t: string): string {
  const x = String(t || '');
  const base = function (p: string): string {
    const b = p.replace(/\\/g, '/').split('/').pop() || '';
    return b.length > 20 ? b.slice(0, 17) + '\u2026' : b;
  };
  if (/module\.json5 with read_file/i.test(x)) {
    if (/list_dir/i.test(x)) return '\u8BFB\u53D6\u6A21\u5757\u914D\u7F6E\u5E76\u5217\u51FA\u76EE\u5F55\uFF0C\u56DE\u7B54\u884C\u6570';
    if (/mainElement/i.test(x)) return '\u8BFB\u53D6\u6A21\u5757\u914D\u7F6E\uFF0C\u56DE\u7B54 mainElement \u7684\u503C';
    return '\u8BFB\u53D6\u6A21\u5757\u914D\u7F6E module.json5';
  }
  if (/with read_file/i.test(x)) {
    if (/sum of their line counts/i.test(x)) return '\u8BFB\u53D6\u4E24\u4E2A\u6587\u4EF6\uFF0C\u56DE\u7B54\u884C\u6570\u603B\u548C';
    if (/last word on the last line/i.test(x)) return '\u8BFB\u53D6\u6587\u4EF6\uFF0C\u56DE\u7B54\u672B\u884C\u672B\u8BCD';
    if (/first word of the first line/i.test(x)) return '\u8BFB\u53D6\u6587\u4EF6\uFF0C\u56DE\u7B54\u9996\u884C\u9996\u8BCD';
    if (/line count as a digit/i.test(x)) return '\u8BFB\u53D6\u6587\u4EF6\uFF0C\u56DE\u7B54\u884C\u6570\uFF08\u6570\u5B57\uFF09';
    if (/FOUND|MISSING/i.test(x)) return '\u8BFB\u53D6\u6587\u4EF6\uFF0C\u5224\u65AD\u662F\u5426\u5305\u542B\u6307\u5B9A\u8BCD';
    const m = /Read\s+([^\s,]+\.txt)/i.exec(x);
    const name = m ? base(m[1]) : '';
    return '\u8BFB\u53D6\u6587\u4EF6 ' + (name || '') + '\uFF0C\u6309\u6307\u4EE4\u7CBE\u786E\u56DE\u7B54';
  }
  if (/List the directory/i.test(x) || /list_dir/i.test(x)) return '\u5217\u51FA\u76EE\u5F55\uFF0C\u56DE\u7B54\u6587\u4EF6\u6570\u91CF';
  if (/read_file/i.test(x)) return '\u8BFB\u53D6\u6587\u4EF6\uFF0C\u6309\u6307\u4EE4\u7CBE\u786E\u56DE\u7B54';
  return x;
}

/** Serialized source for the single-file page: the pure functions above are
 *  injected verbatim into page.ts's <script> (single source of truth). */
export function uiLiteSource(): string {
  return [fuzzyMatchScore, parseUnifiedDiff, looksLikeDiff, renderMarkdown, extractPlan, extractDeliverables, zhTask]
    .map(function (f) { return f.toString(); }).join('\n');
}
