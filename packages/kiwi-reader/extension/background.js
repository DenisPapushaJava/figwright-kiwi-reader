import { waitForWebSocketOpen } from './bridge-connection.js';
import { frameBudgetError } from './frame-budget.js';

const BRIDGE_URL = 'ws://127.0.0.1:9224';
const BRIDGE_CONNECT_TIMEOUT_MS = 5_000;
const CAPTURE_TIMEOUT_MS = 20_000;
const attachedTabs = new Set();
const tabStates = new Map();
const readyTimers = new Map();
const captureTimers = new Map();
const blockedFrameTabs = new Set();
let bridge = null;
let connecting = null;
let keepAlive = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

const initialState = tabId => ({
  tabId,
  attached: false,
  bridgeConnected: false,
  phase: 'idle',
  title: null,
  fileKey: null,
  selectedNodeId: null,
  schemaReady: false,
  nodes: 0,
  decodedFrames: 0,
  ignoredFrames: 0,
  errorCode: null,
  errorMessage: null,
});

const getState = tabId => tabStates.get(tabId) ?? initialState(tabId);

const badgeForState = state => {
  switch (state.phase) {
    case 'ready':
      return { text: '✓', color: '#16803c', title: 'Figwright: макет готов к чтению' };
    case 'reading':
      return { text: 'SYNC', color: '#2563eb', title: 'Figwright: чтение узлов Figma' };
    case 'connecting':
    case 'reloading':
    case 'waiting':
      return { text: '…', color: '#9a6700', title: 'Figwright: подключение к Figma' };
    case 'reconnecting':
      return { text: 'WAIT', color: '#9a6700', title: 'Figwright: локальный MCP недоступен' };
    case 'error':
      return {
        text: 'ERR',
        color: '#b42318',
        title: `Figwright: ${state.errorCode ?? 'ошибка'}`,
      };
    default:
      return { text: '', color: '#666666', title: 'Figwright Kiwi Reader' };
  }
};

const publishState = async (tabId, patch = {}) => {
  const state = { ...getState(tabId), ...patch, tabId };
  tabStates.set(tabId, state);
  const badge = badgeForState(state);
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: badge.text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }),
    chrome.action.setTitle({ tabId, title: badge.title }),
  ]);
  void chrome.runtime.sendMessage({ type: 'kiwi-state', state }).catch(() => {});
  return state;
};

const reportError = (tabId, errorCode, error) =>
  publishState(tabId, {
    phase: 'error',
    errorCode,
    errorMessage: error instanceof Error ? error.message : String(error),
  });

const send = message => {
  if (bridge?.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(message));
};

const closeBridgeIfIdle = () => {
  if (attachedTabs.size > 0) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (bridge?.readyState === WebSocket.OPEN) bridge.close(1000, 'No attached Figma tabs');
};

const removeAttachedTab = (tabId, publish = true) => {
  clearTabTimers(tabId);
  blockedFrameTabs.delete(tabId);
  const wasAttached = attachedTabs.delete(tabId);
  if (wasAttached) send({ type: 'detach', tabId });
  if (publish) void publishState(tabId, initialState(tabId));
  else tabStates.delete(tabId);
  if (wasAttached) closeBridgeIfIdle();
};

const sendHello = async (tabId, reset = false) => {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith('https://www.figma.com/')) return;
  send({ type: 'hello', tabId, url: tab.url, title: tab.title, reset });
  await publishState(tabId, { title: tab.title ?? null });
};

const clearTimer = (timers, tabId) => {
  clearTimeout(timers.get(tabId));
  timers.delete(tabId);
};

const clearTabTimers = tabId => {
  clearTimer(readyTimers, tabId);
  clearTimer(captureTimers, tabId);
};

const scheduleReady = tabId => {
  clearTimer(readyTimers, tabId);
  readyTimers.set(
    tabId,
    setTimeout(() => {
      readyTimers.delete(tabId);
      if (attachedTabs.has(tabId)) void publishState(tabId, { phase: 'ready' });
    }, 800),
  );
};

const scheduleCaptureTimeout = tabId => {
  clearTimer(captureTimers, tabId);
  captureTimers.set(
    tabId,
    setTimeout(() => {
      captureTimers.delete(tabId);
      if (attachedTabs.has(tabId) && getState(tabId).nodes === 0) {
        void reportError(
          tabId,
          'FIGMA_STREAM_TIMEOUT',
          new Error('За 20 секунд Figma не передала структуру макета'),
        );
      }
    }, CAPTURE_TIMEOUT_MS),
  );
};

const applyCaptureStatus = session => {
  if (
    !Number.isInteger(session?.tabId) ||
    !attachedTabs.has(session.tabId) ||
    blockedFrameTabs.has(session.tabId)
  ) {
    return;
  }
  const phase = session.schemaReady && session.nodes > 0 ? 'reading' : 'waiting';
  void publishState(session.tabId, {
    attached: true,
    bridgeConnected: true,
    phase,
    title: session.title,
    fileKey: session.fileKey,
    selectedNodeId: session.selectedNodeId,
    schemaReady: session.schemaReady,
    nodes: session.nodes,
    decodedFrames: session.decodedFrames,
    ignoredFrames: session.ignoredFrames,
    errorCode: null,
    errorMessage: null,
  });
  if (phase === 'reading') {
    clearTimer(captureTimers, session.tabId);
    scheduleReady(session.tabId);
  }
};

const detachAll = async () => {
  const tabIds = [...attachedTabs];
  attachedTabs.clear();
  blockedFrameTabs.clear();
  await Promise.all(
    tabIds.map(async tabId => {
      clearTabTimers(tabId);
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // The tab or debugger session may already be gone.
      }
      await publishState(tabId, initialState(tabId));
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
        await publishState(tabId, {
          bridgeConnected: true,
          phase: 'reloading',
          errorCode: null,
          errorMessage: null,
          schemaReady: false,
          nodes: 0,
          decodedFrames: 0,
          ignoredFrames: 0,
        });
        await sendHello(tabId, true);
        await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
        scheduleCaptureTimeout(tabId);
        await chrome.debugger.sendCommand({ tabId }, 'Page.reload', { ignoreCache: false });
      } catch (error) {
        console.error('[Figwright Kiwi Reader] reconnect', error);
        await reportError(tabId, 'CAPTURE_RESTART_FAILED', error);
      }
    }),
  );
};

const connectBridge = () => {
  if (bridge?.readyState === WebSocket.OPEN) return Promise.resolve();
  if (connecting !== null) return connecting;

  const socket = new WebSocket(BRIDGE_URL);
  bridge = socket;
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'capture-status') applyCaptureStatus(message.session);
      if (message.type === 'capture-error' && attachedTabs.has(message.tabId)) {
        clearTabTimers(message.tabId);
        void publishState(message.tabId, {
          attached: true,
          bridgeConnected: true,
          phase: 'error',
          title: message.session?.title ?? getState(message.tabId).title,
          fileKey: message.session?.fileKey ?? getState(message.tabId).fileKey,
          selectedNodeId: message.session?.selectedNodeId ?? getState(message.tabId).selectedNodeId,
          schemaReady: message.session?.schemaReady ?? false,
          nodes: message.session?.nodes ?? 0,
          decodedFrames: message.session?.decodedFrames ?? 0,
          ignoredFrames: message.session?.ignoredFrames ?? 0,
          errorCode: message.code,
          errorMessage: message.message,
        });
      }
    } catch {
      // Ignore messages from incompatible bridge versions.
    }
  });
  socket.addEventListener('close', event => {
    if (bridge === socket) bridge = null;
    clearInterval(keepAlive);
    keepAlive = null;
    if (event.code === 1000) void detachAll();
    else {
      for (const tabId of attachedTabs) {
        clearTabTimers(tabId);
        void publishState(tabId, {
          bridgeConnected: false,
          phase: 'reconnecting',
          errorCode: 'BRIDGE_CONNECTION_LOST',
          errorMessage: 'Нет связи с локальным MCP',
        });
      }
      scheduleReconnect();
    }
  });

  const attempt = waitForWebSocketOpen(socket, BRIDGE_CONNECT_TIMEOUT_MS)
    .then(() => {
      const reconnecting = attachedTabs.size > 0;
      reconnectDelay = 1000;
      clearInterval(keepAlive);
      keepAlive = setInterval(() => send({ type: 'ping' }), 20_000);
      if (reconnecting) void resyncAttachedTabs();
      return undefined;
    })
    .catch(error => {
      if (bridge === socket) bridge = null;
      if (socket.readyState === WebSocket.OPEN) socket.close();
      throw error;
    })
    .finally(() => {
      if (connecting === attempt) connecting = null;
    });
  connecting = attempt;
  return connecting;
};

const reloadCapture = async tabId => {
  clearTabTimers(tabId);
  blockedFrameTabs.delete(tabId);
  await publishState(tabId, {
    phase: 'reloading',
    errorCode: null,
    errorMessage: null,
    schemaReady: false,
    nodes: 0,
    decodedFrames: 0,
    ignoredFrames: 0,
  });
  await sendHello(tabId, true);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  scheduleCaptureTimeout(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Page.reload', { ignoreCache: false });
};

const attach = async tab => {
  if (!tab.id || !tab.url?.startsWith('https://www.figma.com/')) {
    throw Object.assign(new Error('Откройте макет Figma в активной вкладке'), {
      code: 'NOT_FIGMA_TAB',
    });
  }
  if (attachedTabs.has(tab.id)) {
    await reloadCapture(tab.id);
    return;
  }
  await publishState(tab.id, {
    phase: 'connecting',
    title: tab.title ?? null,
    errorCode: null,
    errorMessage: null,
  });
  try {
    await connectBridge();
  } catch (error) {
    throw Object.assign(error, { code: 'LOCAL_MCP_OFFLINE' });
  }
  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  } catch (error) {
    throw Object.assign(error, { code: 'DEBUGGER_ATTACH_FAILED' });
  }
  attachedTabs.add(tab.id);
  await publishState(tab.id, { attached: true, bridgeConnected: true, phase: 'reloading' });
  try {
    await reloadCapture(tab.id);
  } catch (error) {
    removeAttachedTab(tab.id);
    try {
      await chrome.debugger.detach({ tabId: tab.id });
    } catch {
      // The failed capture may already have detached the debugger.
    }
    throw Object.assign(error, { code: 'CAPTURE_START_FAILED' });
  }
};

const detach = async tabId => {
  const wasAttached = attachedTabs.has(tabId);
  removeAttachedTab(tabId);
  if (wasAttached) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Reaching the desired detached state is sufficient.
    }
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !['get-state', 'connect', 'recapture', 'disconnect'].includes(message.type)) {
    return false;
  }

  void (async () => {
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId)) throw new Error('Не удалось определить вкладку');
    if (message.type === 'get-state') return getState(tabId);
    if (message.type === 'disconnect') {
      await detach(tabId);
      return getState(tabId);
    }
    const tab = await chrome.tabs.get(tabId);
    if (message.type === 'connect') await attach(tab);
    else if (attachedTabs.has(tabId)) await reloadCapture(tabId);
    else await attach(tab);
    return getState(tabId);
  })()
    .then(state => sendResponse({ ok: true, state }))
    .catch(async error => {
      const tabId = Number(message.tabId);
      const code = typeof error?.code === 'string' ? error.code : 'UNEXPECTED_EXTENSION_ERROR';
      if (Number.isInteger(tabId)) await reportError(tabId, code, error);
      sendResponse({ ok: false, error: error.message, code });
    });
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId || !attachedTabs.has(source.tabId)) return;
  if (method === 'Network.webSocketFrameReceived' && params.response?.opcode === 2) {
    if (blockedFrameTabs.has(source.tabId)) return;
    const budgetError = frameBudgetError(
      params.response.payloadData.length,
      bridge?.bufferedAmount ?? 0,
    );
    if (budgetError !== null) {
      blockedFrameTabs.add(source.tabId);
      clearTabTimers(source.tabId);
      void reportError(source.tabId, budgetError.code, new Error(budgetError.message));
      return;
    }
    send({ type: 'frame', tabId: source.tabId, payload: params.response.payloadData });
  }
});

chrome.debugger.onDetach.addListener(source => {
  if (!source.tabId || !attachedTabs.has(source.tabId)) return;
  removeAttachedTab(source.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!attachedTabs.has(tabId) || changeInfo.url === undefined) return;
  void sendHello(tabId);
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (attachedTabs.has(tabId)) removeAttachedTab(tabId, false);
  else tabStates.delete(tabId);
});
