// 点击工具栏图标：打开（或切换到）译读主页面
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
    if (ctx.length && ctx[0].tabId >= 0) {
      await chrome.tabs.update(ctx[0].tabId, { active: true });
      if (ctx[0].windowId >= 0) await chrome.windows.update(ctx[0].windowId, { focused: true });
      return;
    }
  } catch (e) { /* 旧版浏览器没有 getContexts，直接新开 */ }
  await chrome.tabs.create({ url });
});
