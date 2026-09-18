const BRIDGE_URL = 'ws://127.0.0.1:9224';
const attachedTabs = new Set();
let bridge = null;
let connecting = null;
let keepAlive = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

const setBadge = async (tabId, text, color) => {
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
};

const send = message => {
  if (bridge?.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(message));
};

const sendHello = async (tabId, reset = false) => {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith('https://www.figma.com/')) return;
  send({ type: 'hello', tabId, url: tab.url, title: tab.title, reset });
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

const scheduleReconnect = () => {
  if (attachedTabs.size === 0 || reconnectTimer !== null) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectBridge().catch(() => scheduleReconnect());
  }, delay);
};

const resyncAttachedTabs = async () => {
  await Promise.all(
    [...attachedTabs].map(async tabId => {
      try {
        await sendHello(tabId, true);
        await setBadge(tabId, 'SYNC', '#9a6700');
        await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
        await chrome.debugger.sendCommand({ tabId }, 'Page.reload', { ignoreCache: false });
        await setBadge(tabId, 'ON', '#16803c');
      } catch (error) {
        console.error('[Figwright Kiwi Reader] reconnect', error);
        await setBadge(tabId, 'ERR', '#b42318');
      }
    }),
  );
};

const connectBridge = () => {
  if (bridge?.readyState === WebSocket.OPEN) return Promise.resolve();
  if (connecting !== null) return connecting;

  connecting = new Promise((resolve, reject) => {
    const socket = new WebSocket(BRIDGE_URL);
    bridge = socket;
    socket.addEventListener('open', () => {
      const reconnecting = attachedTabs.size > 0;
      connecting = null;
      reconnectDelay = 1000;
      clearInterval(keepAlive);
      keepAlive = setInterval(() => send({ type: 'ping' }), 20_000);
      if (reconnecting) void resyncAttachedTabs();
      resolve();
    });
    socket.addEventListener('error', () => {
      connecting = null;
      reject(new Error('Local Kiwi bridge is not running'));
    });
    socket.addEventListener('close', event => {
      if (bridge === socket) bridge = null;
      connecting = null;
      clearInterval(keepAlive);
      keepAlive = null;
      if (event.code === 1000) void detachAll();
      else {
        for (const tabId of attachedTabs) void setBadge(tabId, 'WAIT', '#9a6700');
        scheduleReconnect();
      }
    });
  });
  return connecting;
};

const attach = async tab => {
  if (!tab.id || !tab.url?.startsWith('https://www.figma.com/')) {
    throw new Error('Open a Figma file in the active tab first');
  }
  await connectBridge();
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  attachedTabs.add(tab.id);
  await sendHello(tab.id, true);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable');
  await setBadge(tab.id, 'ON', '#16803c');
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.reload', { ignoreCache: false });
};

const detach = async tabId => {
  if (attachedTabs.has(tabId)) await chrome.debugger.detach({ tabId });
  attachedTabs.delete(tabId);
  await setBadge(tabId, '', '#666666');
  if (attachedTabs.size === 0) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    bridge?.close(1000, 'No attached Figma tabs');
  }
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
    send({ type: 'frame', tabId: source.tabId, payload: params.response.payloadData });
  }
});

chrome.debugger.onDetach.addListener(source => {
  if (!source.tabId) return;
  attachedTabs.delete(source.tabId);
  void setBadge(source.tabId, '', '#666666');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!attachedTabs.has(tabId) || changeInfo.url === undefined) return;
  void sendHello(tabId);
});
