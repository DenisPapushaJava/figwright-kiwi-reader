# Figwright Kiwi Reader

Браузерный read-only адаптер Figwright для чтения макетов Figma без Figma-плагина, REST-токена,
OAuth и лимитов REST API. Расширение Chrome получает только входящие бинарные WebSocket-кадры уже
открытого пользователем файла, а локальный MCP-сервер декодирует Kiwi scenegraph и отдаёт выбранный
узел агенту разработки.

Проект основан на открытом [Figwright](https://github.com/awdr74100/figwright) и сохраняет исходную
MIT-лицензию. Обычный двунаправленный Figwright остаётся в репозитории; Kiwi Reader является
отдельным провайдером чтения и не меняет макет.

## Возможности

- работа с Figma Design непосредственно в Chrome;
- чтение выбранного фрейма или узла из Figma URL;
- геометрия, auto-layout, тексты, заливки, эффекты и структура потомков;
- несколько открытых файлов и вкладок;
- ограничение глубины, количества узлов и размера ответа;
- section plan для последовательного чтения больших экранов;
- постоянная боковая панель Chrome с прогрессом и диагностикой;
- вызов из любого нового диалога Codex через `@fk`;
- отсутствие команд изменения Figma.

Kiwi — внутренний и недокументированный протокол Figma. Его формат может измениться. Reader получает
схему из текущей браузерной сессии и возвращает понятную ошибку совместимости, но бессрочная
совместимость не гарантируется.

## Быстрый запуск из исходников

Требуются Node.js 24, pnpm 12, Chrome 116+ и Codex.

```powershell
git clone https://github.com/DenisPapushaJava/figwright-kiwi-reader.git
Set-Location figwright-kiwi-reader
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Для ручной проверки запустите MCP-сервер:

```powershell
node .\packages\kiwi-reader\dist\mcp.mjs
```

Загрузите `packages\kiwi-reader\extension` через `chrome://extensions` → **Режим разработчика** →
**Загрузить распакованное расширение**. Откройте Figma, выделите фрейм, нажмите значок расширения и
выберите **Подключить макет**.

## Установка готового релиза

1. Скачайте `figwright-kiwi-reader-vX.Y.Z.zip` из GitHub Releases.
2. Распакуйте архив в постоянную папку.
3. Запустите `install.ps1` в PowerShell.
4. Откройте `chrome://extensions`, включите режим разработчика и загрузите распакованное расширение
   из пути, который напечатал установщик.
5. Перезапустите Codex.

После этого в новом диалоге доступны команды:

```text
@fk проверь подключение к Figma
@fk прочитай выбранный фрейм
@fk получи полный design context выбранного фрейма
@fk прочитай узел https://www.figma.com/design/...?node-id=...
```

Установщик размещает сервер и расширение в `%LOCALAPPDATA%\FigwrightKiwi`, создаёт персональный
Codex-плагин `fk` и регистрирует его в локальном marketplace. Глобальная Git-конфигурация и другие
проекты не изменяются. При обновлении повторно запустите `install.ps1` из нового релиза и нажмите
**Обновить** у расширения на странице `chrome://extensions`.

## Сборка переносимого комплекта

```powershell
corepack pnpm build
corepack pnpm package:kiwi
```

Готовая папка появится в `artifacts\figwright-kiwi-reader`. Сервер собирается вместе с runtime-
зависимостями, поэтому на другом ПК для запуска нужен Node.js 24, но не нужны pnpm и `node_modules`.

## Работа с изменениями

Каждая отдельная функция, ошибка или правка документации выполняется в собственной ветке и
попадает в `main` только через Pull Request:

```powershell
git switch main
git pull --ff-only origin main
git switch -c feat/short-name # либо fix/..., docs/...
# внести изменения и выполнить проверки
git push -u origin HEAD
```

Один PR должен решать одну логическую задачу. Заголовок PR оформляется как Conventional Commit,
например `fix(tools): recapture raster bodies without browser cache`. После успешного CI используется
**Squash and merge**. Прямые коммиты и push в `main` для обычной разработки запрещены; исключение —
только документированный release-коммит, создаваемый `pnpm release`. Заголовок остаётся на
английском для changelog и автоматики, а описание задачи, изменения, проверки и заметки ревьюеру
пишутся на русском.

## Релизный цикл

Kiwi Reader выпускается независимо от основного Figwright:

1. Изменить код и добавить проверяющие тесты.
2. Обновить `version` в `packages/kiwi-reader/extension/manifest.json` и в шаблоне плагина
   `packages/kiwi-reader/release/codex-plugin/.codex-plugin/plugin.json`.
3. Выполнить все обязательные проверки:

   ```powershell
   corepack pnpm typecheck
   corepack pnpm lint
   corepack pnpm format:check
   corepack pnpm knip
   corepack pnpm build
   corepack pnpm test
   corepack pnpm package:kiwi
   ```

4. Проверить собранную папку на чистом Windows-профиле и выполнить реальное чтение простого и
   большого макета.
5. Создать и отправить тег, совпадающий с версией manifest:

   ```powershell
   git tag kiwi-v0.3.1
   git push origin kiwi-v0.3.1
   ```

Workflow `Kiwi Reader Release` повторно выполняет проверки, создаёт ZIP и SHA-256 checksum, после
чего публикует GitHub Release. Теги `kiwi-v*` отделены от upstream-тегов `v*`, чтобы случайно не
запустить публикацию оригинального `@figwright/mcp` в npm.

## Безопасность и границы

- Передаются только server-to-browser WebSocket-фреймы; исходящие команды не пересылаются.
- Cookies и токены Figma не читаются и не сохраняются.
- Локальный сервер слушает только `127.0.0.1` и принимает соединение доверенного расширения.
- Диагностика не содержит содержимое макета и сырые сетевые кадры.
- Размер одного кадра, очереди, scenegraph и MCP-ответа ограничен.
- В Reader отсутствуют encode, replay и инструменты изменения Figma.

Подробности реализации находятся в
[`packages/kiwi-reader/README.md`](./packages/kiwi-reader/README.md) и
[`skills/figma-kiwi-reader/references/implementation-plan.md`](./skills/figma-kiwi-reader/references/implementation-plan.md).
