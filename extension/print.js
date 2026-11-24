// 从 IndexedDB 读出要打印的书，放进 iframe，自动弹出打印（另存为 PDF）
(async () => {
  const id = location.hash.slice(1);
  const job = await new Promise((res, rej) => {
    const r = indexedDB.open('yidu', 1);
    r.onsuccess = () => {
      const t = r.result.transaction('jobs', 'readwrite');
      const st = t.objectStore('jobs');
      const g = st.get(id);
      g.onsuccess = () => res(g.result);
      g.onerror = () => rej(g.error);
    };
    r.onerror = () => rej(r.error);
  });
  if (!job) { document.body.textContent = '打印任务已过期，请回到译读重新点 PDF。'; return; }
  document.title = job.name;
  const f = document.getElementById('f');
  f.srcdoc = job.html;
  f.onload = () => {
    try { f.contentDocument.title = job.name; } catch (e) {}
    setTimeout(() => f.contentWindow.print(), 400);
  };
  document.getElementById('again').onclick = () => f.contentWindow.print();
})();
