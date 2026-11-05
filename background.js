const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen = null;

async function hasOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [documentUrl] });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({ url: OFFSCREEN_URL, reasons: ['USER_MEDIA'], justification: 'Capture the selected tab and process its audio with Web Audio.' }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function getRunningTabId() {
  const captures = await chrome.tabCapture.getCapturedTabs();
  const capture = captures.find(item => item.status === 'active' || item.status === 'pending');
  return capture ? capture.tabId : null;
}

async function stopCapture() {
  if (await hasOffscreenDocument()) {
    try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }); } catch (_) {}
    try { await chrome.offscreen.closeDocument(); } catch (_) {}
  }
  await chrome.storage.local.set({ runningTabId: null });
}

async function startCapture(tabId) {
  const runningTabId = await getRunningTabId();
  if (runningTabId === tabId) return { ok: true, runningTabId: tabId };
  if (runningTabId !== null) await stopCapture();
  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const stored = await chrome.storage.local.get('fxState');
  const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, tabId, state: stored.fxState || null });
  if (!result?.ok) throw new Error(result?.error || 'Unable to start tab audio capture.');
  await chrome.storage.local.set({ runningTabId: tabId });
  return { ok: true, runningTabId: tabId };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return false;
  if (message?.type === 'start-capture') {
    startCapture(message.tabId).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'stop-capture') {
    stopCapture().then(() => sendResponse({ ok: true, runningTabId: null })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'get-status') {
    getRunningTabId().then(async runningTabId => {
      await chrome.storage.local.set({ runningTabId });
      sendResponse({ ok: true, runningTabId });
    }).catch(error => sendResponse({ ok: false, error: error.message, runningTabId: null }));
    return true;
  }
  if (message?.type === 'update-state') {
    chrome.storage.local.set({ fxState: message.state }).then(async () => {
      try {
        if (await hasOffscreenDocument()) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'update-state', state: message.state });
      } catch (_) {}
      sendResponse({ ok: true });
    }).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

chrome.tabCapture.onStatusChanged.addListener(info => {
  if (info.status === 'active' || info.status === 'pending') chrome.storage.local.set({ runningTabId: info.tabId });
  if (info.status === 'stopped' || info.status === 'error') {
    chrome.storage.local.set({ runningTabId: null });
    hasOffscreenDocument().then(exists => { if (exists) chrome.offscreen.closeDocument().catch(() => {}); }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => chrome.storage.local.set({ runningTabId: null }));
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.set({ runningTabId: null }));
