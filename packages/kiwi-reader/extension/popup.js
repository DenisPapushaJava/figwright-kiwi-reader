const elements = {
  extensionVersion: document.querySelector('#extension-version'),
  statusDot: document.querySelector('#status-dot'),
  statusTitle: document.querySelector('#status-title'),
  statusDetail: document.querySelector('#status-detail'),
  errorCard: document.querySelector('#error-card'),
  copyDiagnostics: document.querySelector('#copy-diagnostics'),
  fileCard: document.querySelector('#file-card'),
  fileTitle: document.querySelector('#file-title'),
  nodeName: document.querySelector('#node-name'),
  nodeLabel: document.querySelector('#node-label'),
  captureSummary: document.querySelector('#capture-summary'),
  nodeCount: document.querySelector('#node-count'),
  captureOptions: document.querySelector('#capture-options'),
  captureImages: document.querySelector('#capture-images'),
  captureImagesHelp: document.querySelector('#capture-images-help'),
  recaptureNote: document.querySelector('#recapture-note'),
  pin: document.querySelector('#pin-action'),
  primary: document.querySelector('#primary-action'),
  disconnect: document.querySelector('#disconnect-action'),
};

const phaseCopy = {
  idle: ['Макет не подключён', 'Нажмите кнопку, чтобы передать макет AI-ассистенту'],
  connecting: ['Подключаю макет', 'Проверяю связь с локальным сервисом'],
  reloading: ['Перезагружаю вкладку', 'После загрузки начнётся чтение макета'],
  waiting: ['Жду данные Figma', 'Чтение начнётся после загрузки макета'],
  reading: ['Читаю структуру макета', 'Большой макет может потребовать больше времени'],
  ready: ['Структура макета доступна', 'AI-ассистент может запрашивать полученные узлы'],
  reconnecting: ['Связь с локальным сервисом потеряна', 'Восстанавливаю подключение'],
  error: ['Не удалось завершить чтение', 'Попробуйте обновить данные'],
};

let tabId = null;
let currentState = null;
let supportedTab = false;
const isSidePanel = document.body.classList.contains('side-panel');
const reloadExtensionHelp =
  'Обновите расширение на chrome://extensions, затем откройте панель снова';

const setText = (element, value) => {
  if (element.textContent !== value) element.textContent = value;
};

const extensionVersion = chrome.runtime.getManifest().version;
setText(elements.extensionVersion, `v${extensionVersion}`);
elements.extensionVersion.title = `Версия расширения ${extensionVersion}`;

const cleanTitle = title => title?.replace(/\s*[–-]\s*Figma\s*$/i, '').trim() || 'Макет Figma';
const formatNumber = value => new Intl.NumberFormat('ru-RU').format(value ?? 0);

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
      extensionVersion,
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
  setText(elements.statusTitle, supportedTab ? title : 'Откройте макет Figma');
  setText(
    elements.statusDetail,
    supportedTab
      ? state?.errorMessage || fallbackDetail
      : 'Расширение работает только на figma.com',
  );
  elements.statusDot.className = `status-dot ${
    phase === 'ready'
      ? 'ready'
      : phase === 'error'
        ? 'error'
        : phase === 'reconnecting'
          ? 'warning'
          : phase === 'idle'
            ? ''
            : 'active'
  }`;
  elements.errorCard.hidden = phase !== 'error';
  elements.fileCard.hidden = state?.attached !== true;
  elements.fileTitle.textContent = state?.title ? cleanTitle(state.title) : 'Не выбран';
  elements.fileTitle.title = state?.title ?? '';
  const selectedNodeName = state?.selectedNodeName?.trim() || null;
  setText(
    elements.nodeLabel,
    state?.selectionSource === 'url' ? 'Узел из ссылки' : 'Выбранный узел',
  );
  elements.nodeName.textContent =
    selectedNodeName ?? state?.selectedNodeId ?? 'Выберите узел в Figma';
  elements.nodeName.title = selectedNodeName ?? state?.selectedNodeId ?? '';
  elements.captureSummary.hidden = state?.attached !== true;
  setText(elements.nodeCount, formatNumber(state?.nodes));
  elements.captureImages.checked = state?.captureImages === true;
  elements.captureOptions.hidden = !supportedTab;
  const captureOptionsSupported = state?.captureOptionsSupported === true;
  elements.captureImagesHelp.textContent = captureOptionsSupported
    ? state?.attached
      ? 'Для фото и текстур. После изменения нажмите «Обновить данные».'
      : 'Для фото и текстур из макета.'
    : reloadExtensionHelp;

  const busy = ['connecting', 'reloading'].includes(phase);
  if (elements.pin) elements.pin.disabled = !supportedTab;
  elements.primary.disabled = !supportedTab || busy;
  elements.primary.textContent = state?.attached ? 'Обновить данные' : 'Подключить макет';
  elements.disconnect.hidden = !state?.attached;
  elements.disconnect.disabled = busy;
  elements.recaptureNote.hidden = !state?.attached;
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
