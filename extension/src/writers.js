// 把 Book 写成 EPUB / HTML / TXT，或为 PDF 生成可打印的 HTML
import { mdToHtml, mdToText, esc } from './md.js';

// 根据模式取某个单元要显示的内容：返回 [{md, cls}]
function pick(u, mode) {
  const hasTr = typeof u.tr === 'string' && u.tr.trim();
  if (mode === 'zh') return [{ md: hasTr ? u.tr : u.md, cls: '' }];
  if (mode === 'bi' && hasTr) return [{ md: u.md, cls: 'orig' }, { md: u.tr, cls: 'tr' }];
  return [{ md: u.md, cls: '' }];
}
const titleOf = (o, key, mode) => {
  const tr = o[key + 'Tr'];
  const orig = o[key] || '';
  if (!tr || mode === 'none') return orig;
  if (mode === 'bi' && tr !== orig) return `${tr}｜${orig}`;
  return tr;
};
export const bookTitle = (b, mode) => titleOf(b, 'title', mode) || b.sourceName;
export const chapterTitle = (c, mode, i) => titleOf(c, 'title', mode) || `第 ${i + 1} 部分`;

const READ_CSS = `
:root{--fg:#22302b;--bg:#fbfaf6;--mute:#8a958f;--line:#e5e2d8;--accent:#0c845b}
@media (prefers-color-scheme:dark){:root{--fg:#d9dfdb;--bg:#171b19;--mute:#7f8a84;--line:#2b322e}}
html{background:var(--bg);color:var(--fg)}
body{margin:0 auto;max-width:42em;padding:2.5em 1.4em 5em;font:1.08em/1.95 "Songti SC","Noto Serif SC","Source Han Serif SC","SimSun",Georgia,serif;text-align:justify}
h1{font-size:1.7em;line-height:1.4;text-align:center;margin:1.2em 0 .3em}
h2{font-size:1.3em;line-height:1.5;margin:2.6em 0 1.2em;text-align:center}
h3,h4,h5,h6{font-size:1.08em;margin:1.6em 0 .8em}
p{margin:0 0 .9em;text-indent:0}
p.orig{color:var(--mute);font-size:.88em;line-height:1.7;margin-bottom:.25em;font-family:Georgia,"Times New Roman",serif}
p.tr{margin-bottom:1.2em}
blockquote{margin:1em 0;padding:.1em 1em;border-left:3px solid var(--line)}
pre{white-space:pre-wrap;font-family:inherit}
hr{border:0;text-align:center;margin:1.8em 0}
hr:after{content:"· · ·";color:var(--mute);letter-spacing:.6em}
.author{text-align:center;color:var(--mute);margin-bottom:3em}
.toc{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:1em 0;margin:2em 0}
.toc a{color:inherit;text-decoration:none;display:block;padding:.15em 0}
.toc a:hover{color:var(--accent)}
.meta{color:var(--mute);font-size:.92em}
.fail{border-bottom:1px dashed #c97b4a}
`;

const EPUB_CSS = `
body{margin:0 4%;line-height:1.85;text-align:justify}
h1{font-size:1.6em;text-align:center;margin:2em 0 .4em;line-height:1.4}
h2{font-size:1.25em;text-align:center;margin:1.5em 0 1.2em;line-height:1.5}
h3,h4,h5,h6{font-size:1.05em;margin:1.4em 0 .7em}
p{margin:0 0 .8em;text-indent:0}
p.orig{color:#888;font-size:.88em;line-height:1.65;margin-bottom:.2em}
p.tr{margin-bottom:1.1em}
blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #ccc}
pre{white-space:pre-wrap;font-family:inherit}
hr{border:0;border-top:1px dotted #aaa;width:30%;margin:1.6em auto}
.author{text-align:center;color:#888;margin-bottom:2em}
`;

function blocksHtml(blocks, mode) {
  let h = '';
  for (const b of blocks) {
    if (b.t === 'hr') { h += '<hr/>\n'; continue; }
    if (b.t === 'q') {
      h += '<blockquote>' + pick(b, mode).map(({ md, cls }) => `<p${cls ? ` class="${cls}"` : ''}>${mdToHtml(md)}</p>`).join('') + '</blockquote>\n';
      continue;
    }
    for (const { md, cls } of pick(b, mode)) {
      const c = cls ? ` class="${cls}${b.fail && cls !== 'orig' ? ' fail' : ''}"` : (b.fail ? ' class="fail"' : '');
      const inner = mdToHtml(md);
      if (b.t === 'h') { const lv = Math.min(6, Math.max(3, b.lv || 3)); h += `<h${lv}${c}>${inner}</h${lv}>\n`; }
      else if (b.t === 'pre') h += `<pre${c}>${esc(md)}</pre>\n`;
      else h += `<p${c}>${inner}</p>\n`;
    }
  }
  return h;
}

// ---------- 单文件 HTML ----------
export function toHtml(book, mode, { forPrint = false } = {}) {
  const lang = mode === 'none' ? (book.lang || 'en') : 'zh-CN';
  const title = bookTitle(book, mode);
  let toc = '', body = '';
  book.chapters.forEach((c, i) => {
    const ct = chapterTitle(c, mode, i);
    toc += `<a href="#c${i + 1}">${esc(ct)}</a>\n`;
    body += `<section id="c${i + 1}"${forPrint && i ? ' style="break-before:page"' : ''}>\n<h2>${esc(ct)}</h2>\n${blocksHtml(c.blocks, mode)}</section>\n`;
  });
  const printCss = forPrint ? `@page{margin:18mm 16mm}@media print{html,body{background:#fff;color:#111}body{max-width:none;padding:0}p.orig{color:#666}.toc a{color:#111}}` : '';
  return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title><style>${READ_CSS}${printCss}</style></head><body>
<h1>${esc(title)}</h1>${book.author ? `<div class="author">${esc(book.author)}</div>` : ''}
${book.chapters.length > 1 ? `<nav class="toc">${toc}</nav>` : ''}
${body}</body></html>`;
}

// ---------- TXT ----------
export function toTxt(book, mode) {
  const out = [];
  out.push(bookTitle(book, mode));
  if (book.author) out.push(book.author);
  out.push('');
  book.chapters.forEach((c, i) => {
    out.push('', '', chapterTitle(c, mode, i), '');
    for (const b of c.blocks) {
      if (b.t === 'hr') { out.push('* * *', ''); continue; }
      for (const { md } of pick(b, mode)) out.push(mdToText(md), '');
    }
  });
  return '﻿' + out.join('\r\n');
}

// ---------- EPUB 3（附带 EPUB 2 的 toc.ncx，老阅读器也能看目录） ----------
export async function toEpub(book, mode) {
  const lang = mode === 'none' ? (book.lang || 'en') : 'zh-CN';
  const title = bookTitle(book, mode);
  const uid = 'urn:uuid:' + crypto.randomUUID();
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file('OEBPS/style.css', EPUB_CSS);
  const xhtml = (t, inner) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>${esc(t)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>${inner}</body></html>`;

  zip.file('OEBPS/title.xhtml', xhtml(title, `<h1>${esc(title)}</h1>${book.author ? `<div class="author">${esc(book.author)}</div>` : ''}`));
  const items = [], spine = [], navLis = [], ncxPts = [];
  book.chapters.forEach((c, i) => {
    const id = 'c' + String(i + 1).padStart(4, '0');
    const ct = chapterTitle(c, mode, i);
    zip.file(`OEBPS/${id}.xhtml`, xhtml(ct, `<h2>${esc(ct)}</h2>\n${blocksHtml(c.blocks, mode)}`));
    items.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    navLis.push(`<li><a href="${id}.xhtml">${esc(ct)}</a></li>`);
    ncxPts.push(`<navPoint id="n${i + 1}" playOrder="${i + 2}"><navLabel><text>${esc(ct)}</text></navLabel><content src="${id}.xhtml"/></navPoint>`);
  });
  zip.file('OEBPS/nav.xhtml', xhtml('目录', `<nav epub:type="toc" id="toc"><h2>目录</h2><ol>${navLis.join('')}</ol></nav>`));
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uid}"/></head>
<docTitle><text>${esc(title)}</text></docTitle><navMap><navPoint id="n0" playOrder="1"><navLabel><text>${esc(title)}</text></navLabel><content src="title.xhtml"/></navPoint>${ncxPts.join('')}</navMap></ncx>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">${uid}</dc:identifier><dc:title>${esc(title)}</dc:title>${book.author ? `<dc:creator>${esc(book.author)}</dc:creator>` : ''}
<dc:language>${lang}</dc:language><meta property="dcterms:modified">${now}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
${items.join('\n')}
</manifest>
<spine toc="ncx"><itemref idref="title"/>${spine.join('')}</spine>
</package>`);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
