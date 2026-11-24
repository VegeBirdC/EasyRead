// 设置（chrome.storage.local）与本地缓存（IndexedDB）

export const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  concurrency: 6,
  batchChars: 2400,
  temperature: 1.3,
  outFormat: 'epub',
  transMode: 'zh',        // none | zh | bi
  autoGlossary: true,
  style: 'natural',       // natural | faithful
  glossary: '',
};

export async function loadSettings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...s };
}
export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('yidu', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('tcache')) d.createObjectStore('tcache');
      if (!d.objectStoreNames.contains('jobs')) d.createObjectStore('jobs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
  }));
}
export const idbGet = (store, key) => tx(store, 'readonly', s => s.get(key));
export const idbPut = (store, key, val) => tx(store, 'readwrite', s => { s.put(val, key); });
export const idbClear = (store) => tx(store, 'readwrite', s => { s.clear(); });
export const idbCount = (store) => tx(store, 'readonly', s => s.count());

export async function getMany(store, keys) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readonly');
    const s = t.objectStore(store);
    const out = new Array(keys.length);
    keys.forEach((k, i) => { const r = s.get(k); r.onsuccess = () => { out[i] = r.result; }; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
}

export async function sha1(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
