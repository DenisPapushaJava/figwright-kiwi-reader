const elements = {
  statusDot: document.querySelector('#status-dot'),
  statusTitle: document.querySelector('#status-title'),
  statusDetail: document.querySelector('#status-detail'),
  progress: document.querySelector('#progress'),
  errorCard: document.querySelector('#error-card'),
  errorCode: document.querySelector('#error-code'),
  copyDiagnostics: document.querySelector('#copy-diagnostics'),
  fileTitle: document.querySelector('#file-title'),
  nodeId: document.querySelector('#node-id'),
  nodeCount: document.querySelector('#node-count'),
  frameCount: document.querySelector('#frame-count'),
  captureImages: document.querySelector('#capture-images'),
  captureImagesHelp: document.querySelector('#capture-images-help'),
  pin: document.querySelector('#pin-action'),
  primary: document.querySelector('#primary-action'),
  disconnect: document.querySelector('#disconnect-action'),
};

const phaseCopy = {
  idle: ['Макет не подключён', 'Нажмите кнопку, чтобы передать макет в Codex'],
  connecting: ['Подключаю локальный MCP', 'Проверяю связь на 127.0.0.1'],
  reloading: ['Перезагружаю вкладку', 'После загрузки начнётся чтение макета'],
  waiting: ['Жду данные Figma', 'Ищу схему fig-wire и первые узлы'],
  reading: ['Читаю структуру макета', 'Счётчик растёт по мере получения узлов'],
  ready: ['Макет готов к чтению', 'Codex уже может запрашивать выбранный узел'],
  reconnecting: ['Связь с MCP потеряна', 'Переподключаюсь автоматически'],
  error: ['Не удалось завершить чтение', 'Скопируйте диагностику или повторите захват'],
};

let tabId = null;
let currentState = null;
let supportedTab = false;
const isSidePanel = document.body.classList.contains('side-panel');
const captureImagesHelp = 'Включите для фото; макетные заглушки можно пропустить';
const reloadExtensionHelp =
  'Обновите расширение на chrome://extensions, затем откройте панель снова';

const formatNumber = value => new Intl.NumberFormat('ru-RU').format(value ?? 0);

const cleanTitle = title => title?.replace(/\s*[–-]\s*Figma\s*$/i, '').trim() || 'Макет Figma';

const diagnostics = state =>
  JSON.stringify(
    {
      errorCode: state?.errorCode ?? null,
      errorMessage: state?.errorMessage ?? null,
      phase: state?.phase ?? null,
      fileKey: state?.fileKey ?? null,
      selectedNodeId: state?.selectedNodeId ?? null,
      schemaReady: state?.schemaReady ?? false,
      nodes: state?.nodes ?? 0,
      decodedFrames: state?.decodedFrames ?? 0,
      ignoredFrames: state?.ignoredFrames ?? 0,
      captureImages: state?.captureImages === true,
      extensionVersion: chrome.runtime.getManifest().version,
    },
    null,
    2,
  );

const copyText = async text => {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Clipboard API is unavailable');
  }
};

const requestError = message => {
  const staleContext =
    /message port closed|receiving end does not exist|extension context invalidated/i.test(message);
  const error = new Error(staleContext ? reloadExtensionHelp : message);
  if (staleContext) error.code = 'EXTENSION_RELOAD_REQUIRED';
  return error;
};

const render = state => {
  currentState = state;
  const phase = state?.phase ?? 'idle';
  const [title, fallbackDetail] = phaseCopy[phase] ?? phaseCopy.idle;
  elements.statusTitle.textContent = supportedTab ? title : 'Откройте макет Figma';
  elements.statusDetail.textContent = supportedTab
    ? state?.errorMessage || fallbackDetail
    : 'Расширение работает только на figma.com';
  elements.statusDot.className = `status-dot ${
    phase === 'ready' ? 'ready' : phase === 'error' ? 'error' : phase === 'idle' ? '' : 'active'
  }`;
  elements.progress.className = `progress ${
    phase === 'ready' ? 'ready' : phase === 'error' ? 'error' : phase === 'idle' ? '' : 'active'
  }`;
  elements.errorCard.hidden = phase !== 'error' && phase !== 'reconnecting';
  elements.errorCode.textContent = state?.errorCode ?? 'UNKNOWN_ERROR';
  elements.fileTitle.textContent = state?.title ? cleanTitle(state.title) : 'Не выбран';
  elements.fileTitle.title = state?.title ?? '';
  elements.nodeId.textContent = state?.selectedNodeId ?? '—';
  elements.nodeCount.textContent = formatNumber(state?.nodes);
  elements.frameCount.textContent = formatNumber(state?.decodedFrames);
  elements.captureImages.checked = state?.captureImages === true;
  const captureOptionsSupported = state?.captureOptionsSupported === true;
  elements.captureImagesHelp.textContent = captureOptionsSupported
    ? captureImagesHelp
    : reloadExtensionHelp;

  const busy = ['connecting', 'reloading'].includes(phase);
  if (elements.pin) elements.pin.disabled = !supportedTab;
  elements.primary.disabled = !supportedTab || busy;
  elements.primary.textContent = state?.attached ? 'Считать заново' : 'Подключить макет';
  elements.disconnect.hidden = !state?.attached;
  elements.disconnect.disabled = busy;
  elements.captureImages.disabled = !supportedTab || busy || !captureOptionsSupported;
};

const request = (type, payload = {}) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, tabId, ...payload }, response => {
      if (chrome.runtime.lastError) {
        reject(requestError(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        const error = new Error(response?.error ?? 'Неизвестная ошибка');
        error.code = response?.code;
        reject(error);
        return;
      }
      resolve(response.state);
    });
  });

const runAction = async type => {
  elements.primary.disabled = true;
  elements.disconnect.disabled = true;
  try {
    render(await request(type));
  } catch (error) {
    render({
      ...currentState,
      phase: 'error',
      errorCode: error.code ?? 'POPUP_REQUEST_FAILED',
      errorMessage: error.message,
    });
  }
};

const refreshActiveTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  supportedTab = tab?.url?.startsWith('https://www.figma.com/') === true;
  if (tabId === null) {
    render(null);
    return;
  }
  try {
    render(await request('get-state'));
  } catch (error) {
    render({
      phase: 'error',
      errorCode: error.code ?? 'PANEL_INIT_FAILED',
      errorMessage: error.message,
    });
  }
};

elements.primary.addEventListener('click', () => {
  void runAction(currentState?.attached ? 'recapture' : 'connect');
});

elements.disconnect.addEventListener('click', () => {
  void runAction('disconnect');
});

elements.captureImages.addEventListener('change', async () => {
  if (currentState?.captureOptionsSupported !== true) {
    render({
      ...currentState,
      phase: 'error',
      errorCode: 'EXTENSION_RELOAD_REQUIRED',
      errorMessage: reloadExtensionHelp,
    });
    return;
  }
  elements.captureImages.disabled = true;
  try {
    render(
      await request('set-capture-options', {
        captureImages: elements.captureImages.checked,
      }),
    );
  } catch (error) {
    render({
      ...currentState,
      phase: 'error',
      errorCode: error.code ?? 'CAPTURE_OPTIONS_FAILED',
      errorMessage: error.message,
    });
  }
});

elements.pin?.addEventListener('click', async () => {
  if (tabId === null || !supportedTab) return;
  elements.pin.disabled = true;
  try {
    await chrome.sidePanel.open({ tabId });
    window.close();
  } catch (error) {
    elements.pin.disabled = false;
    render({
      ...currentState,
      phase: 'error',
      errorCode: 'SIDE_PANEL_OPEN_FAILED',
      errorMessage: error.message,
    });
  }
});

elements.copyDiagnostics.addEventListener('click', async () => {
  try {
    await copyText(diagnostics(currentState));
    elements.copyDiagnostics.textContent = 'Скопировано';
  } catch {
    elements.copyDiagnostics.textContent = 'Не удалось скопировать';
  }
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'kiwi-state' && message.state?.tabId === tabId) render(message.state);
});

if (isSidePanel) {
  chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
  chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo) => {
    if (
      updatedTabId === tabId &&
      (changeInfo.url !== undefined || changeInfo.status === 'complete')
    ) {
      void refreshActiveTab();
    }
  });
}

void refreshActiveTab();
