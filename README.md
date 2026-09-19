# Figwright Kiwi Reader

[![CI](https://github.com/DenisPapushaJava/figwright-kiwi-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/DenisPapushaJava/figwright-kiwi-reader/actions/workflows/ci.yml)
[![Actionlint](https://github.com/DenisPapushaJava/figwright-kiwi-reader/actions/workflows/actionlint.yml/badge.svg)](https://github.com/DenisPapushaJava/figwright-kiwi-reader/actions/workflows/actionlint.yml)
[![Zizmor](https://github.com/DenisPapushaJava/figwright-kiwi-reader/actions/workflows/zizmor.yml/badge.svg)](https://github.com/DenisPapushaJava/figwright-kiwi-reader/actions/workflows/zizmor.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Figwright Kiwi Reader** — локальный инструмент для чтения макетов Figma прямо из браузера и
передачи структуры выбранного фрейма в Codex или другой MCP-клиент.

Проект решает конкретную задачу: открыть доступный вам макет в браузерной Figma, выбрать нужный
фрейм, нажать кнопку расширения и попросить агента прочитать дизайн. Запуск Figma-плагина, токен
REST API, OAuth и право администратора макета для этого не требуются.

> Текущая версия: **0.3.1**. Kiwi Reader работает только на чтение и не может изменять макет.

## Как это работает

```text
Figma в Chrome
    │ входящие бинарные WebSocket-кадры Kiwi
    ▼
расширение Figwright Kiwi Reader
    │ локальный WebSocket, только 127.0.0.1
    ▼
локальный MCP-сервер
    │ нормализованный design context
    ▼
Codex / другой MCP-клиент
```

Расширение подключается к уже открытой вкладке через `chrome.debugger`, получает только входящие
бинарные кадры Figma и передаёт их локальному серверу. Сервер восстанавливает scenegraph, удаляет
служебные и слишком объёмные поля и предоставляет шесть read-only MCP-инструментов.

Kiwi Reader не обращается к Figma REST API, поэтому REST-лимиты к этому способу чтения не
относятся. При этом пользователь должен быть авторизован в Figma и иметь обычный доступ к самому
файлу: инструмент не обходит права доступа к макету.

## Что умеет

- читать выбранный во вкладке Figma фрейм или узел из Figma URL;
- возвращать структуру потомков, размеры, координаты, auto-layout, constraints, тексты, шрифты,
  заливки, обводки и эффекты, присутствующие в Kiwi scenegraph;
- формировать компактный `design context` для вёрстки;
- работать с несколькими открытыми файлами Figma;
- разбивать слишком большой экран на план секций для последовательного чтения;
- показывать состояние захвата, число узлов и кадров в popup и закрепляемой боковой панели;
- отдавать стабильный код ошибки и копируемую диагностику без содержимого макета;
- вызываться из любого диалога Codex через `@fk`.

В сервере доступны только:

| MCP-инструмент       | Назначение                                          |
| -------------------- | --------------------------------------------------- |
| `browser_status`     | Проверить соединение расширения и состояние захвата |
| `list_files`         | Показать декодированные вкладки Figma               |
| `use_file`           | Выбрать активный файл при нескольких вкладках       |
| `get_selection`      | Прочитать выбранный узел                            |
| `get_node`           | Прочитать узел по `nodeId`                          |
| `get_design_context` | Получить данные для реализации интерфейса           |

Команд записи, повторной отправки сетевых кадров и изменения Figma в Kiwi Reader нет.

## Ограничения

- Поддерживается Figma Design в Chrome 116+ на Windows.
- Для первого захвата вкладка Figma один раз перезагружается.
- Процесс запускается пользователем: нужно выбрать фрейм и нажать **Подключить макет** или
  **Считать заново**.
- Kiwi — внутренний недокументированный протокол Figma. После изменения протокола со стороны Figma
  может потребоваться обновление декодера.
- Некоторые данные, которых нет во входящем scenegraph, восстановить невозможно. В частности,
  точность variables, component metadata, изображений и шрифтов может отличаться от Figma Plugin
  API.
- Чтение всего большого файла создаёт очень объёмный результат. Для вёрстки лучше выбирать экран,
  секцию или компонент.

Используйте Reader только для файлов, к которым у вас есть законный доступ, и учитывайте правила
вашей организации по работе с дизайн-данными.

## Установка готового релиза

1. Откройте раздел [Releases](https://github.com/DenisPapushaJava/figwright-kiwi-reader/releases).
2. Скачайте `figwright-kiwi-reader-vX.Y.Z.zip` и файл с контрольной суммой `.sha256`.
3. Распакуйте ZIP в постоянную папку и запустите `install.ps1`:

   ```powershell
   .\install.ps1
   ```

4. Установщик разместит файлы в `%LOCALAPPDATA%\FigwrightKiwi`, подключит локальный MCP-сервер и
   персональный Codex-плагин `fk`.
5. Откройте `chrome://extensions`, включите **Режим разработчика**, нажмите
   **Загрузить распакованное расширение** и выберите путь, напечатанный установщиком:

   ```text
   %LOCALAPPDATA%\FigwrightKiwi\extension
   ```

6. Перезапустите Codex.

Установщик требует Node.js 24 или новее. `pnpm`, исходники проекта и папка `node_modules` для
готового релиза не нужны. Если PowerShell блокирует скачанный сценарий, выполните
`Unblock-File .\install.ps1` и запустите его снова.

Пока первый GitHub Release ещё не опубликован, используйте [запуск из исходников](#запуск-из-исходников).

## Как прочитать макет

1. Убедитесь, что Codex запущен с установленным плагином `fk`.
2. Откройте нужный файл на `figma.com` в Chrome.
3. Выберите фрейм или слой. Его `node-id` должен появиться в адресе вкладки.
4. Нажмите значок **Figwright Kiwi Reader**.
5. При необходимости нажмите значок скрепки: управление откроется в боковой панели и не закроется,
   когда вы вернётесь к холсту.
6. Нажмите **Подключить макет**. Расширение подключится к вкладке и один раз перезагрузит её.
7. Дождитесь зелёного состояния готовности и выполните запрос в Codex.

Примеры запросов:

```text
@fk проверь подключение к Figma
@fk прочитай выбранный фрейм
@fk получи design context выбранного фрейма для вёрстки
@fk прочитай узел https://www.figma.com/design/FILE/NAME?node-id=1213-57067
```

Для другого фрейма измените выделение в Figma и нажмите **Считать заново**. Если открыто несколько
подключённых файлов, агент использует `list_files` и `use_file`, чтобы выбрать нужный.

## Состояния и диагностика

На значке расширения отображается краткое состояние:

| Badge  | Значение                         |
| ------ | -------------------------------- |
| `…`    | подключение к локальному серверу |
| `SYNC` | получение и декодирование узлов  |
| `✓`    | макет считан                     |
| `WAIT` | повторное подключение            |
| `ERR`  | ошибка, требующая действия       |

Основные коды ошибок:

| Код                      | Что проверить                                                         |
| ------------------------ | --------------------------------------------------------------------- |
| `LOCAL_MCP_OFFLINE`      | Запущен ли Codex/MCP-сервер и перезапущен ли Codex после установки    |
| `DEBUGGER_ATTACH_FAILED` | Открыта ли вкладка Figma и не подключён ли к ней другой debugger      |
| `FIGMA_STREAM_TIMEOUT`   | Загрузился ли макет; повторите захват после полной загрузки страницы  |
| `KIWI_DECODE_FAILED`     | Вероятно, Figma изменила Kiwi-схему; скопируйте диагностику из панели |
| `CAPTURE_LIMIT_EXCEEDED` | Выберите меньший фрейм или секцию                                     |

Кнопка **Копировать диагностику** не включает cookies, токены, сырые сетевые кадры и содержимое
дизайна.

## Запуск из исходников

Потребуются Git, Node.js 24, pnpm 12, Chrome 116+ и Codex.

```powershell
git clone https://github.com/DenisPapushaJava/figwright-kiwi-reader.git
Set-Location figwright-kiwi-reader
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Загрузите `packages\kiwi-reader\extension` как распакованное расширение Chrome. Для ручной проверки
MCP-сервера запустите:

```powershell
node .\packages\kiwi-reader\dist\mcp.mjs
```

Для создания переносимого локального комплекта:

```powershell
corepack pnpm package:kiwi
```

Результат появится в `artifacts\figwright-kiwi-reader`.

## Проверка изменений

Перед отправкой изменений выполните:

```powershell
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm knip
corepack pnpm build
corepack pnpm test
corepack pnpm package:kiwi
```

Корневой `pnpm test` является обязательным: он запускает тесты пакетов и общие интеграционные
тесты. GitHub Actions дополнительно проверяет сборку на Linux и Windows, синтаксис workflows через
Actionlint и безопасность workflows через Zizmor.

## Релизный цикл

Версия Kiwi Reader хранится в:

- `packages/kiwi-reader/extension/manifest.json`;
- `packages/kiwi-reader/release/codex-plugin/.codex-plugin/plugin.json`.

После обновления обеих версий, прохождения проверок и живого теста в Figma создайте тег с тем же
номером:

```powershell
git tag kiwi-v0.3.1
git push origin kiwi-v0.3.1
```

Workflow `Kiwi Reader Release` повторно выполнит все проверки, соберёт ZIP, создаст SHA-256 и
опубликует GitHub Release. Простые теги `v*` зарезервированы унаследованным релизным процессом
исходного Figwright и для Kiwi Reader не используются.

## Структура репозитория

```text
packages/kiwi-reader/
  extension/       Chrome-расширение, popup и боковая панель
  src/             декодер, локальный bridge и MCP-сервер
  release/         установщик и шаблон Codex-плагина
  test/            тесты Kiwi Reader
scripts/
  package-kiwi-release.mjs
skills/figma-kiwi-reader/
  SKILL.md          инструкция для агента
```

Репозиторий основан на открытом [Figwright](https://github.com/awdr74100/figwright). В нём
сохранена исходная кодовая база, но продукт, который мы развиваем и выпускаем здесь, — read-only
браузерный Kiwi Reader из `packages/kiwi-reader`. Оригинальный репозиторий подключён разработчикам
как Git remote `upstream` только для осознанного переноса полезных обновлений.

Подробности реализации находятся в
[`packages/kiwi-reader/README.md`](./packages/kiwi-reader/README.md) и
[`skills/figma-kiwi-reader/references/implementation-plan.md`](./skills/figma-kiwi-reader/references/implementation-plan.md).

## Безопасность и лицензия

- Локальный bridge слушает только `127.0.0.1`.
- Сервер принимает соединение только от расширения с закреплённым ID.
- Размер сетевого кадра, очереди, scenegraph и MCP-ответа ограничен.
- Расширение не читает и не сохраняет cookies или токены Figma.
- Данные, возвращённые MCP-инструментом, передаются вашему MCP-клиенту и обрабатываются согласно
  его настройкам конфиденциальности.

Код распространяется по лицензии [MIT](./LICENSE). Авторство и история исходного Figwright
сохранены в Git-истории и лицензии.
