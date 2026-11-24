// 读取 EPUB / HTML / TXT / PDF，统一成 Book 结构：
// { title, author, lang, chapters: [{ title, blocks: [{ t:'p'|'h'|'q'|'hr'|'pre', md }] }] }
import { nodeToMd, cleanMd } from './md.js';

const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'LI', 'UL', 'OL', 'DL', 'DD', 'DT',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'HR', 'TABLE', 'TR', 'TD', 'TH', 'TBODY', 'THEAD', 'FIGURE',
  'FIGCAPTION', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'CENTER', 'DETAILS', 'SUMMARY', 'ADDRESS', 'BODY']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'NAV', 'SVG', 'IFRAME', 'FORM', 'BUTTON', 'SELECT']);

export const SUPPORTED = ['epub', 'html', 'htm', 'xhtml', 'txt', 'md', 'pdf'];

export async function parseFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const base = file.name.replace(/\.[^.]+$/, '');
  let book;
  if (ext === 'epub') book = await parseEpub(await file.arrayBuffer());
  else if (ext === 'html' || ext === 'htm' || ext === 'xhtml') book = parseHtml(decodeText(await file.arrayBuffer()));
  else if (ext === 'txt' || ext === 'md') book = parseTxt(decodeText(await file.arrayBuffer()));
  else if (ext === 'pdf') book = await parsePdf(await file.arrayBuffer());
  else if (['mobi', 'azw3', 'azw'].includes(ext)) throw new Error('暂不支持 MOBI/AZW3（加密格式）。在 AO3 作品页点 Download → EPUB 重新下载即可。');
  else throw new Error('不支持的格式：.' + ext);
  if (!book.title) book.title = base;
  book.chapters = book.chapters.filter(c => c.blocks.length || c.title);
  if (!book.chapters.length) throw new Error('没有读到文字。如果是扫描版/图片 PDF，需要先 OCR。');
  book.sourceName = base;
  book.sourceExt = ext;
  return book;
}

export function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
  catch { try { return new TextDecoder('gb18030').decode(u8); } catch { return new TextDecoder('windows-1252').decode(u8); } }
}

// ---------- DOM → blocks ----------
function hasBlockChild(el) {
  for (const c of el.children) if (BLOCK_TAGS.has(c.tagName.toUpperCase())) return true;
  return false;
}

export function domToBlocks(root) {
  const blocks = [];
  const push = (t, el) => {
    const md = cleanMd(nodeToMd(el));
    if (md) blocks.push(t === 'h' ? { t, md, lv: +(el.tagName[1]) || 2 } : { t, md });
  };
  const walk = (el) => {
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (el.getAttribute && (el.getAttribute('hidden') !== null || /display\s*:\s*none/i.test(el.getAttribute('style') || ''))) return;
    if (tag === 'HR') { blocks.push({ t: 'hr', md: '' }); return; }
    if (/^H[1-6]$/.test(tag)) { push('h', el); return; }
    if (tag === 'PRE') { const md = el.textContent.replace(/\s+$/, ''); if (md.trim()) blocks.push({ t: 'pre', md }); return; }
    if (!hasBlockChild(el)) {
      if (tag === 'BODY' || tag === 'DIV' || tag === 'SECTION' || tag === 'BLOCKQUOTE' || tag === 'TD') {
        // 纯文字容器：按 <br><br> 切段（一些 HTML 小说整章只用 br 分段）
        const md = cleanMd(nodeToMd(el));
        if (!md) return;
        const parts = md.split(/\n\s*\n/);
        for (const p of parts) if (p.trim()) blocks.push({ t: tag === 'BLOCKQUOTE' ? 'q' : 'p', md: p.trim() });
        return;
      }
      push(tag === 'BLOCKQUOTE' ? 'q' : 'p', el);
      return;
    }
    // 混合内容：散落的文字节点也要收集
    let buf = null;
    const flush = () => {
      if (buf) { const md = cleanMd(nodeToMd(buf)); if (md) blocks.push({ t: 'p', md }); buf = null; }
    };
    for (const c of [...el.childNodes]) {
      if (c.nodeType === 1 && BLOCK_TAGS.has(c.tagName.toUpperCase()) || c.nodeType === 1 && /^H[1-6]$|^HR$|^PRE$/i.test(c.tagName)) {
        flush();
        const before = blocks.length;
        walk(c);
        if (tag === 'BLOCKQUOTE') for (let i = before; i < blocks.length; i++) if (blocks[i].t === 'p') blocks[i].t = 'q';
      } else if (c.nodeType === 1 && SKIP_TAGS.has(c.tagName.toUpperCase())) {
        continue;
      } else if (c.nodeType === 1 || c.nodeType === 3) {
        if (!buf) buf = el.ownerDocument.createElement('span');
        buf.appendChild(c.cloneNode(true));
      }
    }
    flush();
  };
  walk(root);
  return blocks;
}

// 按 h1/h2 切章（单文件 HTML / 合并内容时用）
function splitByHeadings(blocks, fallbackTitle) {
  const hs = blocks.filter(b => b.t === 'h');
  if (!hs.length) return [{ title: fallbackTitle || '', blocks }];
  const minLv = Math.min(...hs.map(b => b.lv));
  // 如果最高级标题只出现一次（多半是书名），用下一级切
  let lv = minLv;
  if (hs.filter(b => b.lv === minLv).length === 1 && hs.some(b => b.lv > minLv)) lv = Math.min(...hs.filter(b => b.lv > minLv).map(b => b.lv));
  const chapters = [];
  let cur = { title: '', blocks: [] };
  for (const b of blocks) {
    if (b.t === 'h' && b.lv <= lv) {
      if (cur.blocks.length || cur.title) chapters.push(cur);
      cur = { title: b.md.replace(/\n/g, ' '), blocks: [] };
    } else cur.blocks.push(b);
  }
  if (cur.blocks.length || cur.title) chapters.push(cur);
  return chapters;
}

// ---------- HTML ----------
export function parseHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const meta = (n) => doc.querySelector(`meta[name="${n}"]`)?.getAttribute('content') || '';
  let title = (doc.querySelector('title')?.textContent || '').trim();
  let author = meta('author') || meta('dc.creator');

  // AO3 下载的 HTML：#preface + #chapters(.meta h2.heading + .userstuff) + #afterword
  const ao3 = doc.querySelector('#chapters');
  if (ao3) {
    const h1 = doc.querySelector('#preface h1, #preface .meta h1');
    if (h1) title = h1.textContent.trim();
    const byline = doc.querySelector('#preface .byline a, #preface .byline');
    if (byline) author = byline.textContent.replace(/^\s*by\s+/i, '').trim();
    const chapters = [];
    const pre = doc.querySelector('#preface');
    if (pre) {
      const blocks = domToBlocks(pre).filter(b => !(b.t === 'h' && b.md === title));
      if (blocks.length) chapters.push({ title: 'Preface', blocks, isMeta: true });
    }
    const metas = ao3.querySelectorAll(':scope > .meta.group, :scope > div.meta');
    if (metas.length) {
      for (const m of metas) {
        const heading = m.querySelector('h2.heading, h2, h3');
        const blocks = domToBlocks(m).filter(b => !(b.t === 'h' && heading && b.md === heading.textContent.trim()));
        let el = m.nextElementSibling;
        while (el && !el.matches('.meta.group, div.meta')) {
          blocks.push(...domToBlocks(el));
          el = el.nextElementSibling;
        }
        chapters.push({ title: heading ? heading.textContent.trim() : '', blocks });
      }
    } else {
      chapters.push({ title: title, blocks: domToBlocks(ao3) });
    }
    const after = doc.querySelector('#afterword');
    if (after) { const blocks = domToBlocks(after); if (blocks.length) chapters.push({ title: 'Afterword', blocks, isMeta: true }); }
    return { title, author, lang: doc.documentElement.lang || 'en', chapters };
  }

  const body = doc.body || doc.documentElement;
  const blocks = domToBlocks(body);
  if (!title) { const h = blocks.find(b => b.t === 'h'); if (h) title = h.md; }
  return { title, author, lang: doc.documentElement.lang || 'en', chapters: splitByHeadings(blocks, title) };
}

// ---------- TXT ----------
const NUMW = '(?:\\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty[\\w-]*|thirty[\\w-]*|forty[\\w-]*|fifty[\\w-]*)';
const CH_RE = new RegExp(`^\\s*(?:(?:chapter|ch\\.)\\s*${NUMW}(?![a-z])[\\s\\S]{0,80}|(?:part|book|volume|vol\\.)\\s*${NUMW}(?![a-z])\\s*(?:[:.\\-–—)]|$)[\\s\\S]{0,80}|(?:prologue|epilogue|interlude|afterword|foreword)(?![a-z])\\s*(?:[:.\\-–—][\\s\\S]{0,80})?|第[\\s\\d一二三四五六七八九十百千零〇两]+[章节回卷部集篇][\\s\\S]{0,40})$`, 'i');
export function parseTxt(text) {
  text = text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const blankRatio = lines.filter(l => !l.trim()).length / Math.max(1, lines.length);
  let paras;
  if (blankRatio > 0.15) paras = text.split(/\n\s*\n/).map(p => p.split('\n').map(s => s.trim()).join('\n').trim());
  else paras = lines.map(l => l.trim());
  paras = paras.filter(Boolean);
  const chapters = [];
  let cur = { title: '', blocks: [] };
  let title = '';
  for (const p of paras) {
    if (p.length < 90 && !p.includes('\n') && CH_RE.test(p)) {
      if (cur.blocks.length || cur.title) chapters.push(cur);
      cur = { title: p, blocks: [] };
    } else if (/^[-*_=~#·•\s]{3,}$/.test(p)) cur.blocks.push({ t: 'hr', md: '' });
    else cur.blocks.push({ t: 'p', md: cleanMd(p) });
  }
  if (cur.blocks.length || cur.title) chapters.push(cur);
  if (chapters[0] && !chapters[0].title && chapters[0].blocks[0] && chapters[0].blocks[0].md.length < 100) title = chapters[0].blocks[0].md;
  return { title, author: '', lang: 'en', chapters };
}

// ---------- EPUB ----------
function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }
function resolvePath(base, rel) {
  rel = decodeURIComponent(rel.split('#')[0]);
  const parts = (base + rel).split('/');
  const out = [];
  for (const s of parts) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); }
  return out.join('/');
}
function zfile(zip, path) {
  return zip.file(path) || zip.file(Object.keys(zip.files).find(k => k.toLowerCase() === path.toLowerCase()) || '\0');
}

export async function parseEpub(buf) {
  const zip = await JSZip.loadAsync(buf);
  const cont = await zfile(zip, 'META-INF/container.xml')?.async('string');
  if (!cont) throw new Error('EPUB 结构不完整（缺少 container.xml）');
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const opfPath = xml(cont).querySelector('rootfile')?.getAttribute('full-path');
  const opfText = await zfile(zip, opfPath)?.async('string');
  if (!opfText) throw new Error('EPUB 结构不完整（找不到 OPF）');
  const opf = xml(opfText);
  const base = dirOf(opfPath);
  const byTag = (n) => opf.getElementsByTagName(n)[0] || opf.getElementsByTagNameNS('*', n.split(':').pop())[0];
  const title = (byTag('dc:title')?.textContent || '').trim();
  const author = (byTag('dc:creator')?.textContent || '').trim();
  const lang = (byTag('dc:language')?.textContent || 'en').trim();
  const manifest = {};
  for (const it of opf.getElementsByTagNameNS('*', 'item')) manifest[it.getAttribute('id')] = { href: it.getAttribute('href'), type: it.getAttribute('media-type'), props: it.getAttribute('properties') || '' };

  // 目录标题（nav.xhtml 或 toc.ncx）
  const tocTitles = {};
  try {
    const navItem = Object.values(manifest).find(m => m.props.includes('nav'));
    if (navItem) {
      const p = resolvePath(base, navItem.href);
      const nav = new DOMParser().parseFromString(await zfile(zip, p).async('string'), 'text/html');
      for (const a of nav.querySelectorAll('nav a[href]')) {
        const k = resolvePath(dirOf(p), a.getAttribute('href'));
        if (!tocTitles[k]) tocTitles[k] = a.textContent.trim();
      }
    } else {
      const ncxItem = Object.values(manifest).find(m => /ncx/.test(m.type || ''));
      if (ncxItem) {
        const p = resolvePath(base, ncxItem.href);
        const ncx = xml(await zfile(zip, p).async('string'));
        for (const np of ncx.getElementsByTagNameNS('*', 'navPoint')) {
          const src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src');
          const lbl = np.getElementsByTagNameNS('*', 'text')[0]?.textContent.trim();
          if (src) { const k = resolvePath(dirOf(p), src); if (!tocTitles[k]) tocTitles[k] = lbl; }
        }
      }
    }
  } catch (e) { /* 目录坏了就靠正文标题 */ }

  const chapters = [];
  for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
    const item = manifest[ref.getAttribute('idref')];
    if (!item || !/html|xml/.test(item.type || '')) continue;
    const p = resolvePath(base, item.href);
    const f = zfile(zip, p);
    if (!f) continue;
    const src = await f.async('string');
    let doc = new DOMParser().parseFromString(src, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(src, 'text/html');
    const body = doc.body || doc.getElementsByTagName('body')[0];
    if (!body) continue;
    let blocks = domToBlocks(body);
    let ctitle = tocTitles[p] || '';
    const firstH = blocks.findIndex(b => b.t === 'h');
    if (firstH >= 0 && firstH < 3) {
      if (!ctitle) ctitle = blocks[firstH].md.replace(/\n/g, ' ');
      if (blocks[firstH].md.replace(/\n/g, ' ').trim() === ctitle.trim()) blocks.splice(firstH, 1);
    }
    if (!blocks.length && !ctitle) continue;
    chapters.push({ title: ctitle, blocks });
  }
  return { title, author, lang, chapters };
}

// ---------- PDF ----------
export async function parsePdf(buf) {
  const pdfjs = globalThis.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const meta = await pdf.getMetadata().catch(() => ({}));
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    // 按 y 坐标聚成行
    const rows = [];
    for (const it of tc.items) {
      if (!it.str && !it.hasEOL) continue;
      const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
      let row = rows.find(r => Math.abs(r.y - y) < h * 0.45);
      if (!row) { row = { y, h, items: [] }; rows.push(row); }
      row.items.push({ x, s: it.str, w: it.width });
      row.h = Math.max(row.h, h);
    }
    rows.sort((a, b) => b.y - a.y);
    const lines = rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      let s = '', end = null;
      for (const it of r.items) {
        if (end !== null && it.x - end > r.h * 0.2 && !s.endsWith(' ') && !it.s.startsWith(' ')) s += ' ';
        s += it.s; end = it.x + it.w;
      }
      return { y: r.y, h: r.h, x: r.items[0]?.x || 0, right: end || 0, s: s.replace(/\s+/g, ' ').trim() };
    }).filter(l => l.s);
    pages.push(lines);
  }
  // 去掉页码与重复页眉页脚
  const freq = {};
  for (const lines of pages) for (const l of new Set([lines[0]?.s, lines[lines.length - 1]?.s])) if (l) { const k = l.replace(/\d+/g, '#'); freq[k] = (freq[k] || 0) + 1; }
  const isJunk = (l, idx, n) => (idx === 0 || idx === n - 1) && (/^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(l.s) || (pages.length > 3 && freq[l.s.replace(/\d+/g, '#')] > pages.length * 0.5));

  const all = [];
  for (const lines of pages) lines.forEach((l, i) => { if (!isJunk(l, i, lines.length)) all.push({ ...l, newPage: i === 0 }); });
  if (!all.length) return { title: meta?.info?.Title || '', author: meta?.info?.Author || '', lang: 'en', chapters: [] };

  const gaps = [];
  for (let i = 1; i < all.length; i++) if (!all[i].newPage) { const g = all[i - 1].y - all[i].y; if (g > 0) gaps.push(g); }
  gaps.sort((a, b) => a - b);
  const lineGap = gaps[Math.floor(gaps.length / 2)] || 14;
  const rights = all.map(l => l.right).sort((a, b) => a - b);
  const fullRight = rights[Math.floor(rights.length * 0.9)] || 0;
  const lefts = all.map(l => l.x).sort((a, b) => a - b);
  const baseLeft = lefts[Math.floor(lefts.length * 0.1)] || 0;
  const bodyH = all.map(l => l.h).sort((a, b) => a - b)[Math.floor(all.length / 2)] || 10;

  const paras = [];
  let cur = '';
  let curBig = false;
  for (let i = 0; i < all.length; i++) {
    const l = all[i], prev = all[i - 1];
    let brk = !prev;
    if (prev) {
      const gap = prev.y - l.y;
      if (!l.newPage && gap > lineGap * 1.45) brk = true;
      else if (prev.right < fullRight * 0.82 && /[.!?。！？"”’'):…—-]$/.test(prev.s)) brk = true;
      else if (l.x - baseLeft > bodyH * 1.2 && !l.newPage) brk = true; // 首行缩进
      if (Math.abs(l.h - prev.h) > bodyH * 0.3) brk = true;
    }
    if (brk && cur) { paras.push({ s: cur, big: curBig }); cur = ''; }
    if (!cur) { cur = l.s; curBig = l.h > bodyH * 1.25; }
    else if (/[A-Za-z]-$/.test(cur) && /^[a-z]/.test(l.s)) cur = cur.slice(0, -1) + l.s;
    else cur += ' ' + l.s;
  }
  if (cur) paras.push({ s: cur, big: curBig });

  const chapters = [];
  let ch = { title: '', blocks: [] };
  for (const p of paras) {
    const isHead = p.s.length < 90 && (CH_RE.test(p.s) || p.big);
    if (isHead) {
      if (ch.blocks.length || ch.title) chapters.push(ch);
      ch = { title: p.s, blocks: [] };
    } else if (/^[-*_=~·•\s]{3,}$/.test(p.s)) ch.blocks.push({ t: 'hr', md: '' });
    else ch.blocks.push({ t: 'p', md: p.s });
  }
  if (ch.blocks.length || ch.title) chapters.push(ch);
  return { title: (meta?.info?.Title || '').trim(), author: (meta?.info?.Author || '').trim(), lang: 'en', chapters };
}
