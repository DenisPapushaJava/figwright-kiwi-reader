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

  const busy = ['connecting', 'reloading'].includes(phase);
  elements.primary.disabled = !supportedTab || busy;
  elements.primary.textContent = state?.attached ? 'Считать заново' : 'Подключить макет';
  elements.disconnect.hidden = !state?.attached;
  elements.disconnect.disabled = busy;
};

const request = type =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, tabId }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
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

elements.primary.addEventListener('click', () => {
  void runAction(currentState?.attached ? 'recapture' : 'connect');
});

elements.disconnect.addEventListener('click', () => {
  void runAction('disconnect');
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

void (async () => {
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
      errorCode: error.code ?? 'POPUP_INIT_FAILED',
      errorMessage: error.message,
    });
  }
})();
