// DeepSeek 翻译：分批、并发、缓存（断点续译）、失败自动拆分重试
import { getMany, idbPut, sha1 } from './store.js';

const PROMPT_VER = 'v1';

export class FatalApiError extends Error {}

function isDeepSeek(baseUrl) { return /api\.deepseek\.com/i.test(baseUrl); }
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('已停止', 'AbortError')); }, { once: true });
});

export async function chat(s, messages, { json = false, signal, maxTokens = 8192 } = {}) {
  const url = s.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = { model: s.model, messages, temperature: Number(s.temperature) || 1.3, max_tokens: maxTokens, stream: false };
  if (json) body.response_format = { type: 'json_object' };
  if (isDeepSeek(s.baseUrl)) body.thinking = { type: 'disabled' };
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    let r;
    try {
      r = await fetch(url, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey.trim() },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = new Error('网络错误：' + e.message);
      await sleep(1500 * 2 ** attempt, signal); continue;
    }
    if (r.ok) {
      const j = await r.json();
      const ch = j.choices?.[0];
      return { content: ch?.message?.content || '', finish: ch?.finish_reason, usage: j.usage || {} };
    }
    let msg = '';
    try { const j = await r.json(); msg = j.error?.message || JSON.stringify(j); } catch { msg = await r.text().catch(() => ''); }
    if (r.status === 401) throw new FatalApiError('API Key 无效或已被删除（401）。请在“设置”里重新粘贴 Key。');
    if (r.status === 402) throw new FatalApiError('DeepSeek 账户余额不足（402）。充值后点“开始”会从断点继续。');
    if (r.status === 404 || /model/i.test(msg) && r.status === 400 && /not exist|invalid|unknown/i.test(msg)) throw new FatalApiError(`模型“${s.model}”不可用：${msg}。请在设置里点“检测连接”刷新模型列表。`);
    if (r.status === 429 || r.status >= 500) { lastErr = new Error(`服务繁忙（${r.status}）`); await sleep(2000 * 2 ** attempt, signal); continue; }
    const e = new Error(`请求被拒绝（${r.status}）：${msg}`); e.status = r.status; throw e;
  }
  throw lastErr || new Error('请求失败');
}

export async function listModels(s) {
  const r = await fetch(s.baseUrl.replace(/\/+$/, '') + '/models', { headers: { Authorization: 'Bearer ' + s.apiKey.trim() } });
  if (r.status === 401) throw new FatalApiError('API Key 无效（401）');
  if (!r.ok) throw new Error('无法获取模型列表（' + r.status + '）');
  const j = await r.json();
  return (j.data || []).map(m => m.id);
}

// ---------- 术语表 ----------
export function parseGlossary(text) {
  const out = [];
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^\s*(.+?)\s*(?:=|＝|→|->|:|：|\t)\s*(.+?)\s*$/);
    if (m && !line.trim().startsWith('#')) out.push([m[1], m[2]]);
  }
  return out;
}
export function glossaryText(pairs) { return pairs.map(([a, b]) => `${a} = ${b}`).join('\n'); }

function systemPrompt(s, gloss) {
  const style = s.style === 'faithful'
    ? '风格：忠实贴近原文，句式可以保留英文特点，但必须通顺。'
    : '风格：像优秀的中文网文/出版译本，意思准确、读起来自然；保留原文的语气、幽默、口头禅、粗口和情感/亲密描写的力度，不要删减、不要说教、不要加注释。';
  let p = `你是资深文学译者，正在把一部英文小说（多为 AO3 同人作品）翻译成简体中文。
输入是 JSON：{"paragraphs":[...]}，每一项是一段原文。
请输出 JSON：{"translations":[...]}，与输入一一对应：数组长度、顺序必须完全相同，不合并、不拆分、不遗漏。
规则：
1. 保留格式标记：被 *星号* 或 **双星号** 包住的内容，在译文里用同样的标记包住对应部分；段内换行符 \\n 原样保留。
2. 对话使用中文引号“”，省略号用……，破折号用——。
3. 人名、地名、称呼按下面的术语表统一；表里没有的，知名作品用通行中文译名，其余按通行音译，全文保持一致。
4. 章节标题、作者注、标签、统计信息（Words/Chapters 等）也照常翻译；纯数字、符号、网址原样返回。
5. ${style}
6. 只输出 JSON，不要任何解释。`;
  if (gloss.length) p += `\n\n术语表（原文 = 译名）：\n${glossaryText(gloss)}`;
  return p;
}

// ---------- 自动提取人名/术语 ----------
export async function extractGlossary(s, book, { signal } = {}) {
  const texts = [];
  for (const c of book.chapters) { if (c.title) texts.push(c.title); for (const b of c.blocks) if (b.md) texts.push(b.md); }
  const all = texts.join('\n');
  let sample = all.slice(0, 14000);
  if (all.length > 20000) {
    for (const f of [0.3, 0.55, 0.8]) { const i = Math.floor(all.length * f); sample += '\n…\n' + all.slice(i, i + 3500); }
  }
  const sys = `你是文学翻译的术语整理助手。阅读用户给出的英文小说片段，找出需要统一译名的专有名词：人物全名、名、姓、昵称/外号、地名、组织、作品特有的术语。
如果能看出这是某部知名作品的同人（例如哈利·波特、漫威、原神、各类动漫等），请使用该作品通行的官方中文译名。
输出 JSON：{"fandom":"推测的原作（不确定就空字符串）","terms":[{"en":"原文","zh":"中文译名"}]}，最多 80 条，按重要程度排序，只输出 JSON。`;
  const r = await chat(s, [{ role: 'system', content: sys }, { role: 'user', content: sample }], { json: true, signal, maxTokens: 4096 });
  let j; try { j = JSON.parse(r.content); } catch { return { pairs: [], fandom: '', usage: r.usage }; }
  const pairs = (j.terms || []).filter(t => t && t.en && t.zh && t.en !== t.zh).map(t => [String(t.en).trim(), String(t.zh).trim()]);
  return { pairs, fandom: j.fandom || '', usage: r.usage };
}

export function mergeGlossary(userPairs, autoPairs) {
  const seen = new Set(userPairs.map(([a]) => a.toLowerCase()));
  return [...userPairs, ...autoPairs.filter(([a]) => !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()))];
}

// ---------- 收集要翻译的单元 ----------
const CJK = /[㐀-鿿]/g;
function needsTranslation(t) {
  if (!t || !/[A-Za-zÀ-ɏЀ-ӿ]{2,}/.test(t)) return false;
  const cjk = (t.match(CJK) || []).length;
  return cjk / t.length < 0.3;
}
export function collectUnits(book) {
  const units = [];
  if (needsTranslation(book.title)) units.push({ src: book.title, set: v => { book.titleTr = v; } });
  else book.titleTr = book.title;
  for (const c of book.chapters) {
    if (needsTranslation(c.title)) units.push({ src: c.title, set: v => { c.titleTr = v; } });
    for (const b of c.blocks) {
      if (b.t === 'hr' || b.t === 'pre') continue;
      if (needsTranslation(b.md)) units.push({ src: b.md, set: v => { b.tr = v; }, fail: () => { b.fail = true; } });
    }
  }
  return units;
}

export function estimate(units) {
  const chars = units.reduce((n, u) => n + u.src.length, 0);
  const inTok = Math.round(chars / 3.8);
  return { chars, inTok, outTok: Math.round(inTok * 1.15) };
}

// ---------- 主流程 ----------
export async function translateBook(s, book, gloss, { signal, onProgress, onLog } = {}) {
  const units = collectUnits(book);
  const total = units.reduce((n, u) => n + u.src.length, 0);
  const usage = { prompt: 0, completion: 0, cacheHit: 0 };
  const addUsage = (u) => { usage.prompt += u.prompt_tokens || 0; usage.completion += u.completion_tokens || 0; usage.cacheHit += u.prompt_cache_hit_tokens || 0; };
  let done = 0, failed = 0, cached = 0;
  const report = () => onProgress?.({ done, total, failed, cached, usage });

  const gkey = await sha1(PROMPT_VER + '|' + s.model + '|' + s.style + '|' + glossaryText(gloss));
  const keys = await Promise.all(units.map(u => sha1(gkey + '|' + u.src)));
  units.forEach((u, i) => { u.key = keys[i]; });
  const hits = await getMany('tcache', keys);
  const todo = [];
  units.forEach((u, i) => {
    if (typeof hits[i] === 'string') { u.set(hits[i]); done += u.src.length; cached += u.src.length; }
    else todo.push(u);
  });
  report();
  if (!todo.length) return { usage, failed };

  // 分批
  const budget = Math.max(600, Number(s.batchChars) || 2400);
  const batches = [];
  let cur = [], n = 0;
  for (const u of todo) {
    if (cur.length && (n + u.src.length > budget || cur.length >= 40)) { batches.push(cur); cur = []; n = 0; }
    cur.push(u); n += u.src.length;
  }
  if (cur.length) batches.push(cur);

  const sys = systemPrompt(s, gloss);
  let fatal = null;

  const runBatch = async (batch) => {
    if (fatal) return;
    try {
      const r = await chat(s, [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ paragraphs: batch.map(u => u.src) }) }],
        { json: true, signal, maxTokens: Math.min(16000, Math.max(2048, Math.round(batch.reduce((a, u) => a + u.src.length, 0) * 1.2))) });
      addUsage(r.usage);
      let arr = null;
      try { const j = JSON.parse(r.content); arr = Array.isArray(j) ? j : (j.translations || j.paragraphs || Object.values(j).find(Array.isArray)); } catch { }
      if (!arr || arr.length !== batch.length || r.finish === 'length') throw Object.assign(new Error('返回段数不一致'), { split: true });
      for (let i = 0; i < batch.length; i++) {
        const v = typeof arr[i] === 'string' ? arr[i] : String(arr[i] ?? '');
        batch[i].set(v); done += batch[i].src.length;
        idbPut('tcache', batch[i].key, v).catch(() => { });
      }
      report();
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (e instanceof FatalApiError) { fatal = e; throw e; }
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await runBatch(batch.slice(0, mid));
        await runBatch(batch.slice(mid));
      } else {
        failed++; batch[0].fail?.(); done += batch[0].src.length;
        const why = /risk|content|sensitive|审核/i.test(e.message) ? '被 DeepSeek 内容审核拦截' : e.message.slice(0, 80);
        onLog?.(`有 1 段没能翻译（${why}），已保留英文原文：${batch[0].src.slice(0, 40)}…`);
        report();
      }
    }
  };

  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(16, Number(s.concurrency) || 6)) }, async () => {
    while (idx < batches.length && !fatal) {
      const b = batches[idx++];
      await runBatch(b);
    }
  });
  await Promise.all(workers);
  if (fatal) throw fatal;
  return { usage, failed };
}
