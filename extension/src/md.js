// 段落内部用极简标记表示格式：*斜体*  **粗体**  换行用 \n
// 这样翻译时模型容易保留，导出时再还原成 HTML。

const INLINE_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

export function nodeToMd(node) {
  let out = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) out += c.nodeValue.replace(/\s+/g, ' ');
    else if (c.nodeType === 1) {
      const tag = c.tagName.toUpperCase();
      if (INLINE_SKIP.has(tag)) continue;
      if (tag === 'BR') { out += '\n'; continue; }
      if (tag === 'IMG') { const a = c.getAttribute('alt'); if (a) out += a; continue; }
      const inner = nodeToMd(c);
      if (!inner.trim()) { out += inner; continue; }
      if (tag === 'EM' || tag === 'I' || tag === 'CITE' || tag === 'VAR') out += wrap(inner, '*');
      else if (tag === 'STRONG' || tag === 'B') out += wrap(inner, '**');
      else out += inner;
    }
  }
  return out;
}
function wrap(s, m) {
  const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0];
  const core = s.trim();
  if (core.startsWith(m) && core.endsWith(m)) return s; // 已经嵌套过
  return lead + m + core + m + trail;
}

export function cleanMd(s) {
  return s.replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// md → 安全的 (X)HTML 片段
export function mdToHtml(md) {
  let h = esc(md);
  h = h.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<b>$1</b>');
  h = h.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, '$1<i>$2</i>');
  h = h.replace(/\n/g, '<br/>');
  return h;
}

// md → 纯文本（TXT 输出用；保留 *斜体* 星号会让阅读器很乱，所以去掉）
export function mdToText(md) {
  return md.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, '$1$2');
}
