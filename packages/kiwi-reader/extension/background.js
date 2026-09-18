const BRIDGE_URL = 'ws://127.0.0.1:9224';
const attachedTabs = new Set();
let bridge = null;
let keepAlive = null;

const setBadge = async (tabId, text, color) => {
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
};

const send = message => {
  if (bridge?.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(message));
};

const detachAll = async () => {
  const tabIds = [...attachedTabs];
  attachedTabs.clear();
  await Promise.all(
    tabIds.map(async tabId => {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // The tab or debugger session may already be gone.
      }
      await setBadge(tabId, '', '#666666');
    }),
  );
};

const connectBridge = () =>
  new Promise((resolve, reject) => {
    if (bridge?.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const socket = new WebSocket(BRIDGE_URL);
    bridge = socket;
    socket.addEventListener('open', () => {
      clearInterval(keepAlive);
      keepAlive = setInterval(() => send({ type: 'ping' }), 20_000);
      resolve();
    });
    socket.addEventListener('error', () => reject(new Error('Local Kiwi bridge is not running')));
    socket.addEventListener('close', () => {
      if (bridge === socket) bridge = null;
      clearInterval(keepAlive);
      keepAlive = null;
      void detachAll();
    });
  });

const attach = async tab => {
  if (!tab.id || !tab.url?.startsWith('https://www.figma.com/')) {
    throw new Error('Open a Figma file in the active tab first');
  }
  await connectBridge();
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  attachedTabs.add(tab.id);
  send({ type: 'hello', url: tab.url, title: tab.title });
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable');
  await setBadge(tab.id, 'ON', '#16803c');
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.reload', { ignoreCache: false });
};

const detach = async tabId => {
  if (attachedTabs.has(tabId)) await chrome.debugger.detach({ tabId });
  attachedTabs.delete(tabId);
  await setBadge(tabId, '', '#666666');
  if (attachedTabs.size === 0) bridge?.close();
};

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id) return;
  try {
    if (attachedTabs.has(tab.id)) await detach(tab.id);
    else await attach(tab);
  } catch (error) {
    console.error('[Figwright Kiwi Reader]', error);
    await setBadge(tab.id, 'ERR', '#b42318');
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId || !attachedTabs.has(source.tabId)) return;
  if (method === 'Network.webSocketFrameReceived' && params.response?.opcode === 2) {
    send({ type: 'frame', payload: params.response.payloadData });
  }
});

chrome.debugger.onDetach.addListener(source => {
  if (!source.tabId) return;
  attachedTabs.delete(source.tabId);
  void setBadge(source.tabId, '', '#666666');
});
