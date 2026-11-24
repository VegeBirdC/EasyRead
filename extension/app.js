import { loadSettings, saveSettings, idbGet, idbPut, idbClear, idbCount, sha1 } from './src/store.js';
import { parseFile, SUPPORTED } from './src/parsers.js';
import { toEpub, toHtml, toTxt, bookTitle } from './src/writers.js';
import { translateBook, extractGlossary, parseGlossary, mergeGlossary, glossaryText, collectUnits, estimate, listModels, chat, FatalApiError } from './src/translate.js';

const $ = (s) => document.querySelector(s);
let S = await loadSettings();
const items = []; // { id, file, book, status, el, outputs:{} }
let running = null; // AbortController

// ---------- 选项 chips ----------
function bindChips(sel, key, after) {
  const box = $(sel);
  const paint = () => box.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === S[key]));
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S[key] = b.dataset.v; saveSettings({ [key]: S[key] }); paint(); after?.();
  });
  paint();
}
bindChips('#fmtChips', 'outFormat');
bindChips('#modeChips', 'transMode', refresh);
bindChips('#styleChips', 'style');
$('#autoGlossary').checked = !!S.autoGlossary;
$('#autoGlossary').onchange = (e) => { S.autoGlossary = e.target.checked; saveSettings({ autoGlossary: S.autoGlossary }); };
$('#glossary').value = S.glossary || '';
$('#glossary').oninput = (e) => { S.glossary = e.target.value; saveSettings({ glossary: S.glossary }); };

// ---------- 拖放 ----------
const drop = $('#drop');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.classList.add('over'); });
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('over'); } });
document.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; drop.classList.remove('over'); });
document.addEventListener('drop', (e) => { addFiles([...(e.dataTransfer?.files || [])]); });
$('#pick').onclick = (e) => { e.stopPropagation(); $('#fileInput').click(); };
drop.onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
$('#clearList').onclick = () => { if (running) return; items.length = 0; $('#rows').innerHTML = ''; refresh(); };

async function addFiles(files) {
  for (const file of files) {
    const it = { id: crypto.randomUUID(), file, book: null, status: 'parsing', outputs: {} };
    items.push(it);
    it.el = rowEl(it);
    $('#rows').appendChild(it.el);
    refresh();
    try {
      it.book = await parseFile(file);
      it.status = 'ready';
    } catch (e) {
      it.status = 'error'; it.error = e.message || String(e);
      console.error(e);
    }
    paintRow(it); refresh();
  }
}

function rowEl(it) {
  const d = document.createElement('div');
  d.className = 'rowi';
  d.innerHTML = `<div><div class="name"></div><div class="info"></div></div><div class="side"></div><div class="bar"><i></i></div><div class="more" hidden></div>`;
  return d;
}
function words(book) {
  let n = 0; for (const c of book.chapters) for (const b of c.blocks) n += (b.md.match(/[A-Za-z'’-]+/g) || []).length + (b.md.match(/[㐀-鿿]/g) || []).length;
  return n;
}
function fmtWords(n) { return n >= 10000 ? `约 ${(n / 10000).toFixed(1)} 万词` : `${n.toLocaleString()} 词`; }
function paintRow(it) {
  const el = it.el;
  el.querySelector('.name').textContent = it.book ? `${it.book.titleTr && S.transMode !== 'none' && it.book.titleTr !== it.book.title ? it.book.titleTr + '　' : ''}${it.book.title}` : it.file.name;
  const info = el.querySelector('.info');
  const side = el.querySelector('.side');
  side.innerHTML = '';
  if (it.status === 'parsing') info.textContent = '读取中…';
  else if (it.status === 'error') info.innerHTML = `<span class="err">✕ ${escapeHtml(it.error)}</span>`;
  else {
    const b = it.book;
    const base = `${it.file.name} · ${b.chapters.length} 章 · ${fmtWords(words(b))}${b.author ? ' · ' + b.author : ''}`;
    info.textContent = it.msg ? `${base} — ${it.msg}` : base;
    if (it.glossCount) {
      const a = document.createElement('button'); a.className = 'link'; a.textContent = ` 人名表 ${it.glossCount} 条`;
      a.onclick = () => toggleMore(it); info.append(' · ', a);
    }
    if (it.status === 'done') {
      for (const f of ['epub', 'html', 'txt', 'pdf']) {
        const btn = document.createElement('button');
        btn.className = 'dl' + (f === it.lastFormat ? '' : ' sec');
        btn.textContent = (f === it.lastFormat ? '⬇ ' : '') + f.toUpperCase();
        btn.title = f === it.lastFormat ? '再次下载' : '用当前翻译设置导出成 ' + f.toUpperCase();
        btn.onclick = () => exportBook(it, f);
        side.appendChild(btn);
      }
    }
  }
  if (!running) {
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '✕'; x.title = '移除';
    x.onclick = () => { items.splice(items.indexOf(it), 1); el.remove(); refresh(); };
    side.appendChild(x);
  }
}
function toggleMore(it) {
  const m = it.el.querySelector('.more');
  if (!m.hidden) { m.hidden = true; return; }
  m.innerHTML = `本书自动整理的人名表（想改的话，把要改的行复制到下方“自定义人名/术语对照”里改，再点开始会按新译名重译）：<textarea readonly></textarea>`;
  m.querySelector('textarea').value = it.glossText || '';
  m.hidden = false;
}
function setBar(it, p) { it.el.querySelector('.bar i').style.width = Math.round(p * 100) + '%'; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function log(msg) {
  $('#logBox').hidden = false;
  const d = document.createElement('div');
  d.textContent = new Date().toLocaleTimeString() + '　' + msg;
  $('#log').prepend(d);
}

function refresh() {
  $('#list').hidden = !items.length;
  $('#transOpts').hidden = S.transMode === 'none';
  $('#keyWarn').hidden = !(S.transMode !== 'none' && !S.apiKey);
  const ready = items.filter(i => i.book && i.status !== 'parsing');
  $('#start').disabled = !running && !ready.length;
  if (!running) $('#start').textContent = S.transMode === 'none' ? '开始转换' : '开始翻译并转换';
  if (S.transMode !== 'none' && ready.length) {
    let chars = 0, tok = 0;
    for (const it of ready) { const e = estimate(collectUnits(structuredCloneBook(it.book))); chars += e.chars; tok += e.inTok + e.outTok; }
    $('#estimate').textContent = `共约 ${(chars / 10000).toFixed(1)} 万字符，预计消耗约 ${(tok / 10000).toFixed(0)} 万 tokens（已译过的部分不重复计费）`;
  } else $('#estimate').textContent = ready.length ? `共 ${ready.length} 本` : '';
  items.forEach(it => it.el && paintRow(it));
}
// 估算时不要改动原书对象
function structuredCloneBook(b) { return { title: b.title, chapters: b.chapters.map(c => ({ title: c.title, blocks: c.blocks.map(x => ({ t: x.t, md: x.md })) })) }; }

// ---------- 开始 ----------
$('#start').onclick = async () => {
  if (running) { running.abort(); return; }
  const mode = S.transMode;
  if (mode !== 'none' && !S.apiKey) { openSettings(); $('#apiKey').focus(); return; }
  running = new AbortController();
  const signal = running.signal;
  $('#start').textContent = '停止'; $('#start').classList.add('stop'); $('#start').disabled = false;
  refresh();
  const userGloss = parseGlossary(S.glossary);
  try {
    for (const it of items) {
      if (!it.book || signal.aborted) continue;
      it.status = 'working'; it.msg = ''; setBar(it, 0); paintRow(it);
      try {
        if (mode !== 'none') {
          let gloss = userGloss;
          if (S.autoGlossary) {
            it.msg = '正在整理人名表…'; paintRow(it);
            const gk = 'gloss|' + S.model + '|' + await sha1(JSON.stringify(it.book.chapters.slice(0, 3).map(c => c.blocks.slice(0, 50).map(b => b.md))) + it.book.title);
            let auto = await idbGet('tcache', gk);
            if (!auto) {
              try {
                const r = await extractGlossary(S, it.book, { signal });
                auto = { pairs: r.pairs, fandom: r.fandom };
                await idbPut('tcache', gk, auto);
              } catch (e) {
                if (e.name === 'AbortError' || e instanceof FatalApiError) throw e;
                log('自动整理人名表失败，跳过：' + e.message); auto = { pairs: [] };
              }
            }
            gloss = mergeGlossary(userGloss, auto.pairs || []);
            it.glossCount = (auto.pairs || []).length; it.glossText = glossaryText(auto.pairs || []);
            if (auto.fandom) log(`《${it.book.title}》识别为「${auto.fandom}」同人，已整理 ${it.glossCount} 个译名`);
          }
          const t0 = Date.now();
          const res = await translateBook(S, it.book, gloss, {
            signal,
            onLog: log,
            onProgress: ({ done, total, failed, cached }) => {
              const p = total ? done / total : 1;
              setBar(it, p * 0.97);
              const sec = (Date.now() - t0) / 1000;
              const fresh = done - cached;
              const eta = fresh > 0 && p < 1 ? Math.round(sec / fresh * (total - done)) : 0;
              it.msg = `翻译中 ${(p * 100).toFixed(0)}%${eta ? ' · 约剩 ' + fmtTime(eta) : ''}${failed ? ' · ' + failed + ' 段失败' : ''}`;
              paintRow(it);
            },
          });
          const u = res.usage;
          if (u.prompt || u.completion) log(`《${it.book.title}》本次用量：输入 ${u.prompt.toLocaleString()} tokens（其中缓存命中 ${u.cacheHit.toLocaleString()}），输出 ${u.completion.toLocaleString()} tokens`);
          if (res.failed) log(`《${it.book.title}》有 ${res.failed} 段翻译失败，保留了英文原文。再点一次“开始”只会重试这些段落。`);
        }
        await exportBook(it, S.outFormat);
        it.status = 'done'; it.msg = '完成 ✓'; setBar(it, 1);
      } catch (e) {
        if (e.name === 'AbortError') { it.status = 'ready'; it.msg = '已停止（已译部分保存在本地，再点开始会接着译）'; }
        else { it.status = 'ready'; it.msg = '出错，详见下方记录'; log('出错：' + e.message); alertOnce(e); if (e instanceof FatalApiError) { paintRow(it); break; } }
        console.error(e);
      }
      paintRow(it);
    }
  } finally {
    running = null;
    $('#start').classList.remove('stop');
    refresh(); updateCacheInfo();
  }
};
function fmtTime(s) { return s >= 3600 ? `${Math.floor(s / 3600)} 小时 ${Math.round(s % 3600 / 60)} 分` : s >= 60 ? `${Math.round(s / 60)} 分钟` : `${s} 秒`; }
let alerted = false;
function alertOnce(e) { if (alerted) return; alerted = true; setTimeout(() => { alerted = false; }, 3000); if (e instanceof FatalApiError) alert(e.message); }

// ---------- 导出 ----------
function outName(it, fmt) {
  const mode = S.transMode;
  const suffix = mode === 'zh' ? '_中文' : mode === 'bi' ? '_中英对照' : '';
  let base = it.book.sourceName;
  if (mode !== 'none' && it.book.titleTr && it.book.titleTr !== it.book.title) base = it.book.titleTr;
  base = base.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 120) || 'book';
  return `${base}${suffix}.${fmt}`;
}
async function exportBook(it, fmt) {
  const mode = S.transMode;
  const book = it.book;
  it.lastFormat = fmt;
  if (fmt === 'pdf') {
    const id = crypto.randomUUID();
    await idbPut('jobs', id, { html: toHtml(book, mode, { forPrint: true }), name: outName(it, 'pdf').replace(/\.pdf$/, '') });
    window.open(chrome.runtime.getURL('print.html#' + id), '_blank');
    log(`已打开打印页：在弹出的打印窗口里，“目标打印机”选“另存为 PDF”即可保存。`);
    return;
  }
  let blob;
  if (fmt === 'epub') blob = await toEpub(book, mode);
  else if (fmt === 'html') blob = new Blob([toHtml(book, mode)], { type: 'text/html;charset=utf-8' });
  else blob = new Blob([toTxt(book, mode)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = outName(it, fmt);
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- 设置抽屉 ----------
const MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
function fillModels(list) {
  const sel = $('#model');
  const all = [...new Set([...(list || MODELS), S.model].filter(Boolean))];
  sel.innerHTML = all.map(m => `<option value="${m}">${m}</option>`).join('');
  sel.value = S.model;
}
function openSettings() {
  $('#apiKey').value = S.apiKey; $('#baseUrl').value = S.baseUrl; $('#concurrency').value = S.concurrency;
  $('#batchChars').value = S.batchChars; $('#temperature').value = S.temperature;
  fillModels(S.models);
  $('#mask').hidden = false; $('#settings').classList.add('open'); $('#settings').setAttribute('aria-hidden', 'false');
}
function closeSettings() { $('#mask').hidden = true; $('#settings').classList.remove('open'); $('#settings').setAttribute('aria-hidden', 'true'); }
$('#openSettings').onclick = openSettings;
$('#keyWarnLink').onclick = (e) => { e.preventDefault(); openSettings(); };
$('#closeSettings').onclick = closeSettings;
$('#mask').onclick = closeSettings;
$('#toggleKey').onclick = () => { const k = $('#apiKey'); k.type = k.type === 'password' ? 'text' : 'password'; };

function readForm() {
  return {
    apiKey: $('#apiKey').value.trim(),
    baseUrl: ($('#baseUrl').value.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: $('#model').value || 'deepseek-flash',
    concurrency: Math.max(1, Math.min(16, +$('#concurrency').value || 6)),
    batchChars: Math.max(600, Math.min(8000, +$('#batchChars').value || 2400)),
    temperature: Math.max(0, Math.min(2, +$('#temperature').value || 1.3)),
  };
}
async function ensureHostPermission(baseUrl) {
  if (/^https:\/\/api\.deepseek\.com/i.test(baseUrl)) return true;
  try { const origin = new URL(baseUrl).origin + '/*'; return await chrome.permissions.request({ origins: [origin] }); } catch { return false; }
}
$('#saveSettings').onclick = async () => {
  const f = readForm();
  if (!(await ensureHostPermission(f.baseUrl))) { alert('没有获得该接口地址的访问权限'); return; }
  Object.assign(S, f); await saveSettings(f);
  closeSettings(); refresh();
};
$('#testConn').onclick = async () => {
  const f = readForm();
  const out = $('#testResult');
  if (!f.apiKey) { out.textContent = '请先粘贴 Key'; return; }
  if (!(await ensureHostPermission(f.baseUrl))) { out.textContent = '未获得访问权限'; return; }
  out.textContent = '检测中…';
  const s = { ...S, ...f };
  try {
    let models = null;
    try { models = await listModels(s); } catch (e) { if (e instanceof FatalApiError) throw e; }
    if (models && models.length) {
      S.models = models; await saveSettings({ models });
      if (!models.includes(s.model)) s.model = models.includes('deepseek-flash') ? 'deepseek-flash' : models[0];
      S.model = s.model; fillModels(models);
    }
    const r = await chat(s, [{ role: 'user', content: '把 "Good morning, Harry." 翻译成中文，只输出译文。' }], { maxTokens: 50 });
    out.textContent = `✓ 连接成功：${r.content.trim().slice(0, 30)}`;
    Object.assign(S, f, { model: s.model }); await saveSettings({ ...f, model: s.model }); refresh();
  } catch (e) { out.textContent = '✕ ' + e.message; }
};

// ---------- 缓存 ----------
async function updateCacheInfo() { try { $('#cacheInfo').textContent = `本地已缓存 ${(await idbCount('tcache')).toLocaleString()} 段译文`; } catch { } }
$('#clearCache').onclick = async () => {
  if (!confirm('清空后，之前译过的内容再次翻译会重新计费。确定清空吗？')) return;
  await idbClear('tcache'); updateCacheInfo();
};

window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });
fillModels(S.models);
refresh(); updateCacheInfo();
idbClear("jobs").catch(() => { });
if (!S.apiKey && S.transMode !== 'none') setTimeout(openSettings, 300);
void SUPPORTED;
