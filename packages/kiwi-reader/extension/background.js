import { waitForWebSocketOpen } from './bridge-connection.js';
import { frameBudgetError } from './frame-budget.js';
import {
  canForwardImageBody,
  captureReloadOptions,
  imageResponseMetadata,
} from './image-capture.js';

const BRIDGE_URL = 'ws://127.0.0.1:9224';
const BRIDGE_CONNECT_TIMEOUT_MS = 5_000;
const CAPTURE_TIMEOUT_MS = 20_000;
const MAX_REFERENCE_PAYLOAD_CHARS = 45 * 1024 * 1024;
const attachedTabs = new Set();
const tabStates = new Map();
const readyTimers = new Map();
const captureTimers = new Map();
const blockedFrameTabs = new Set();
const imageRequests = new Map();
const sentImageUrls = new Map();
let bridge = null;
let connecting = null;
let keepAlive = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let captureImages = false;
const optionsReady = chrome.storage.local.get({ captureImages: false }).then(options => {
  captureImages = options.captureImages === true;
  return undefined;
});

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
  captureImages,
  captureOptionsSupported: true,
  errorCode: null,
  errorMessage: null,
});

const getState = tabId => tabStates.get(tabId) ?? initialState(tabId);

const badgeForState = state => {
  switch (state.phase) {
    case 'ready':
      return { text: '✓', color: '#16803c', title: 'FigLens: макет готов к чтению' };
    case 'reading':
      return { text: 'SYNC', color: '#2563eb', title: 'FigLens: чтение узлов Figma' };
    case 'connecting':
    case 'reloading':
    case 'waiting':
      return { text: '…', color: '#9a6700', title: 'FigLens: подключение к Figma' };
    case 'reconnecting':
      return { text: 'WAIT', color: '#9a6700', title: 'FigLens: локальный MCP недоступен' };
    case 'error':
      return {
        text: 'ERR',
        color: '#b42318',
        title: `FigLens: ${state.errorCode ?? 'ошибка'}`,
      };
    default:
      return { text: '', color: '#666666', title: 'FigLens' };
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
  imageRequests.delete(tabId);
  sentImageUrls.delete(tabId);
  const wasAttached = attachedTabs.delete(tabId);
  if (wasAttached) send({ type: 'detach', tabId });
  if (publish) void publishState(tabId, initialState(tabId));
  else tabStates.delete(tabId);
  if (wasAttached) closeBridgeIfIdle();
};

const sendHello = async (tabId, reset = false) => {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith('https://www.figma.com/')) return;
  send({ type: 'hello', tabId, url: tab.url, title: tab.title, reset, captureImages });
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
    captureImages: session.captureImages ?? captureImages,
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
        // sendHello resets the server's capture. Start a fresh image request/deduplication window
        // as well, or URLs already sent before the disconnect disappear from the new capture.
        imageRequests.set(tabId, new Map());
        sentImageUrls.set(tabId, new Set());
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
        await chrome.debugger.sendCommand(
          { tabId },
          'Page.reload',
          captureReloadOptions(captureImages),
        );
      } catch (error) {
        console.error('[FigLens] reconnect', error);
        await reportError(tabId, 'CAPTURE_RESTART_FAILED', error);
      }
    }),
  );
};

const captureReference = async message => {
  const tabId = Number(message.tabId);
  const requestId = message.requestId;
  if (!Number.isInteger(tabId) || typeof requestId !== 'string' || !attachedTabs.has(tabId)) {
    return;
  }
  try {
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
    const viewport = metrics?.cssVisualViewport;
    if (
      typeof viewport?.clientWidth !== 'number' ||
      typeof viewport?.clientHeight !== 'number' ||
      typeof viewport?.pageX !== 'number' ||
      typeof viewport?.pageY !== 'number'
    ) {
      throw new Error('Chrome did not return viewport metrics');
    }
    const screenshot = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (
      typeof screenshot?.data !== 'string' ||
      screenshot.data.length > MAX_REFERENCE_PAYLOAD_CHARS
    ) {
      throw new Error('Viewport screenshot exceeds the 32 MiB capture limit');
    }
    send({
      type: 'capture-reference',
      tabId,
      requestId,
      payload: screenshot.data,
      viewport: {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        pageX: viewport.pageX,
        pageY: viewport.pageY,
      },
    });
  } catch (error) {
    send({
      type: 'capture-reference-error',
      tabId,
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
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
      if (message.type === 'capture-reference-request') void captureReference(message);
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
  await optionsReady;
  clearTabTimers(tabId);
  blockedFrameTabs.delete(tabId);
  imageRequests.set(tabId, new Map());
  sentImageUrls.set(tabId, new Set());
  await publishState(tabId, {
    phase: 'reloading',
    errorCode: null,
    errorMessage: null,
    schemaReady: false,
    nodes: 0,
    decodedFrames: 0,
    ignoredFrames: 0,
    captureImages,
  });
  await sendHello(tabId, true);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  scheduleCaptureTimeout(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Page.reload', captureReloadOptions(captureImages));
};

const captureImageResponse = async (tabId, requestId, metadata) => {
  try {
    const response = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', {
      requestId,
    });
    if (
      typeof response?.body !== 'string' ||
      typeof response?.base64Encoded !== 'boolean' ||
      !captureImages ||
      !canForwardImageBody(response.body, response.base64Encoded, bridge?.bufferedAmount ?? 0)
    ) {
      return;
    }
    const sent = sentImageUrls.get(tabId);
    if (sent?.has(metadata.url)) return;
    sent?.add(metadata.url);
    send({
      type: 'asset',
      tabId,
      url: metadata.url,
      mimeType: metadata.mimeType,
      payload: response.body,
      base64Encoded: response.base64Encoded,
    });
  } catch {
    // Cached, redirected or evicted bodies are allowed to remain unresolved in the asset report.
  }
};

const attach = async tab => {
  await optionsReady;
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
  if (
    !message ||
    !['get-state', 'connect', 'recapture', 'disconnect', 'set-capture-options'].includes(
      message.type,
    )
  ) {
    return false;
  }

  void (async () => {
    await optionsReady;
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId)) throw new Error('Не удалось определить вкладку');
    if (message.type === 'get-state') return getState(tabId);
    if (message.type === 'set-capture-options') {
      captureImages = message.captureImages !== false;
      await chrome.storage.local.set({ captureImages });
      if (!captureImages) {
        imageRequests.get(tabId)?.clear();
        sentImageUrls.get(tabId)?.clear();
      }
      return publishState(tabId, { captureImages });
    }
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
      if (Number.isInteger(tabId)) {
        try {
          await reportError(tabId, code, error);
        } catch (reportingError) {
          console.error('[FigLens] Failed to publish extension error state:', reportingError);
        }
      }
      sendResponse({ ok: false, error: error.message, code });
    });
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId || !attachedTabs.has(source.tabId)) return;
  if (method === 'Network.responseReceived') {
    if (!captureImages) return;
    const metadata = imageResponseMetadata(params);
    const requests = imageRequests.get(source.tabId);
    if (metadata !== null && requests !== undefined && requests.size < 5_000) {
      requests.set(metadata.requestId, metadata);
    }
    return;
  }
  if (method === 'Network.loadingFailed') {
    imageRequests.get(source.tabId)?.delete(params.requestId);
    return;
  }
  if (method === 'Network.loadingFinished') {
    const requests = imageRequests.get(source.tabId);
    const metadata = requests?.get(params.requestId);
    requests?.delete(params.requestId);
    if (metadata !== undefined) {
      void captureImageResponse(source.tabId, params.requestId, metadata);
    }
    return;
  }
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
