# FigLens

[![CI](https://github.com/DenisPapushaJava/figwright-kiwi-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/DenisPapushaJava/figwright-kiwi-reader/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**FigLens** — локальный read-only инструмент, который читает выбранный фрейм Figma из Chrome и
передаёт его структуру Codex, Cursor, Claude Code или другому MCP-клиенту.

Для работы не нужны Figma Plugin API, REST-токен, OAuth или права администратора файла. Пользователь
должен быть авторизован в Figma и иметь обычный доступ к макету. FigLens не изменяет дизайн и не
обходит права доступа.

[Скачать последний релиз](https://github.com/DenisPapushaJava/figwright-kiwi-reader/releases/latest)

## Возможности

- чтение выбранного фрейма, слоя или узла из Figma URL;
- геометрия, auto-layout, constraints, тексты, шрифты, заливки, обводки, эффекты и потомки;
- разрешение экземпляров компонентов, shared styles и доступных цветовых переменных;
- экспорт доступных SVG и опциональный захват растровых изображений;
- сопоставление компонентов, иконок и цветов с существующим кодом проекта;
- section plan и кэш для больших экранов и файлов;
- один локальный hub для нескольких MCP-клиентов и вкладок Figma;
- снимок видимой области и pixel diff для визуальной проверки.

## Как это работает

```text
Figma в Chrome
  → расширение FigLens
  → локальный WebSocket bridge и MCP hub
  → Codex / Cursor / Claude Code
```

Расширение через `chrome.debugger` получает входящие бинарные Kiwi-кадры уже открытой вкладки.
Локальный сервер восстанавливает scenegraph и формирует ограниченный по размеру design context.
Cookies, пароль и токены Figma не читаются и не сохраняются. Figma REST API не используется.

## Установка

Требуются Windows, Chrome 116+ и Node.js 24.11+ из ветки 24 либо Node.js 26+.

1. Скачайте `figlens-vX.Y.Z.zip` и `.sha256` из
   [последнего релиза](https://github.com/DenisPapushaJava/figwright-kiwi-reader/releases/latest).
2. Распакуйте ZIP в постоянную папку и запустите `install.ps1`:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

3. Откройте `chrome://extensions`, включите **Режим разработчика**, нажмите
   **Загрузить распакованное расширение** и выберите:

   ```text
   %LOCALAPPDATA%\FigwrightKiwi\extension
   ```

4. Перезапустите используемые MCP-клиенты.

По умолчанию установщик настраивает доступные Codex, Cursor и Claude Code. Список можно ограничить:

```powershell
.\install.ps1 -Clients Codex
.\install.ps1 -Clients Cursor,ClaudeCode
```

Для обновления запустите `install.ps1` из нового релиза, затем нажмите **Обновить** на карточке
FigLens в `chrome://extensions` и перезапустите MCP-клиенты.

Для удаления:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\FigwrightKiwi\uninstall.ps1"
```

## Использование

1. Откройте доступный файл Figma в Chrome и выберите нужный фрейм или слой.
2. Нажмите значок **FigLens** и выберите **Подключить макет**. При первом захвате вкладка один раз
   перезагрузится.
3. Дождитесь зелёного состояния готовности.
4. Попросите MCP-клиент прочитать выбранный узел. Например, в Codex:

   ```text
   @fk проверь подключение к Figma
   @fk прочитай выбранный фрейм
   @fk подготовь выбранный фрейм к реализации в текущем проекте
   @fk прочитай узел https://www.figma.com/design/FILE/NAME?node-id=1213-57067
   ```

Для другого слоя измените выделение и нажмите **Считать заново**. Захват растровых изображений по
умолчанию выключен; включайте его только когда для реализации нужны фотографии или растровые
заливки.

## Диагностика

Состояние hub доступно по адресу <http://127.0.0.1:9225/health>. Кнопка
**Копировать диагностику** не включает содержимое макета, cookies, токены и сырые сетевые кадры.

| Код                         | Действие                                                     |
| --------------------------- | ------------------------------------------------------------ |
| `LOCAL_MCP_OFFLINE`         | Перезапустите MCP-клиент и проверьте `/health`               |
| `DEBUGGER_ATTACH_FAILED`    | Закройте другой debugger и повторно подключите вкладку Figma |
| `KIWI_DECODE_FAILED`        | Обновите FigLens; Figma могла изменить Kiwi-протокол         |
| `CAPTURE_LIMIT_EXCEEDED`    | Выберите меньший фрейм или читайте экран по секциям          |
| `EXTENSION_RELOAD_REQUIRED` | Нажмите **Обновить** в `chrome://extensions`                 |

## Ограничения

- Поддерживается Figma Design в Chrome на Windows.
- Kiwi — внутренний протокол Figma; после его изменения может потребоваться новый релиз FigLens.
- Данные, которых нет во входящем scenegraph, восстановить невозможно. Такие пробелы явно
  отмечаются в `capabilities` и `caveats` ответа.
- Для больших файлов лучше выбирать экран, секцию или компонент и следовать `sectionPlan`.

## Разработка

```powershell
git clone https://github.com/DenisPapushaJava/figwright-kiwi-reader.git
Set-Location figwright-kiwi-reader
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
```

Правила работы находятся в [CONTRIBUTING.md](./CONTRIBUTING.md), техническое устройство reader — в
[packages/kiwi-reader/README.md](./packages/kiwi-reader/README.md). Корневой `pnpm test` обязателен:
он включает пакетные и межпакетные тесты.

## Лицензия

FigLens основан на открытом [Figwright](https://github.com/awdr74100/figwright) и распространяется по
лицензии [MIT](./LICENSE). Исходное авторство и история сохранены в Git.
