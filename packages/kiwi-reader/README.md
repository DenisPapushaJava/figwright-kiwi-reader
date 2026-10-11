# FigLens reader: запуск и разработка

Chrome-расширение передаёт входящие бинарные WebSocket-сообщения открытой вкладки Figma
локальному серверу. Сервер декодирует Kiwi и предоставляет данные через MCP.

[Установка готового релиза](../../README.md)

## Сборка и проверки

Нужны Node.js 24.11+ из ветки 24 или Node.js 26+ и pnpm из `packageManager`.
Из корня репозитория:

```sh
corepack pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm knip
pnpm build
pnpm test
```

`pnpm test` запускается из корня после сборки: часть интеграционных тестов использует `dist`.

## Ручное подключение MCP

Настройте клиент на запуск Node.js с абсолютным путём к `stdio-proxy.mjs`:

```json
{
  "mcpServers": {
    "fl": {
      "command": "node",
      "args": ["/absolute/path/figwright-kiwi-reader/packages/kiwi-reader/dist/stdio-proxy.mjs"]
    }
  }
}
```

В Codex те же `command` и `args` задаются в разделе `[mcp_servers.fl]` файла `config.toml`.
В Windows используйте свой абсолютный путь с экранированными обратными слешами в JSON.

Прокси автоматически запускает общий hub. Несколько клиентов используют одно подключение
расширения. Проверка сервера: <http://127.0.0.1:9225/health>.
Для ручного запуска hub: `node packages/kiwi-reader/dist/hub.mjs`.
Порты меняются через `FIGWRIGHT_KIWI_PORT` (9224) и `FIGWRIGHT_KIWI_HUB_PORT` (9225).
Для авторизации HTTP-клиента задайте `FIGWRIGHT_KIWI_HUB_TOKEN` и передавайте его как Bearer-токен
в запросах к `http://127.0.0.1:9225/mcp`.

Загрузите `packages/kiwi-reader/extension` через **Загрузить распакованное расширение**
в `chrome://extensions`. Откройте Figma → FigLens → **Подключить макет**.
После изменения расширения нажмите **Обновить** на его карточке.

## Инструменты

- `browser_status`, `list_files`, `get_selection` — подключение, файлы и выбранный узел.
- `get_node`, `get_design_context` — данные узла или Figma URL.
- `get_implementation_context` — дизайн, ресурсы и сопоставление с кодом по абсолютному `rootDir`.
- `analyze_project`, `scan_components`, `component_map`, `icon_map`, `token_map` — анализ проекта.
- `save_assets`, `capture_reference`, `compare_screenshots` — ресурсы и визуальная сверка.

Начинайте с `browser_status`. Если подключено несколько вкладок, указывайте `fileKey` или `tabId`
в каждом чтении. Для крупных узлов следуйте `sectionPlan`, сохраняя тот же `rootDir`.
`use_file` доступен в прямом stdio-сервере `dist/mcp.mjs`; у общего hub активный файл не переключается.

## Границы данных

- Восстанавливаются компоненты, переопределения экземпляров, смешанный текст и доступные стили.
  Отсутствующие метаданные отмечаются в ответе, а не угадываются.
- Совпадение цвета с токеном проекта — кандидат для переиспользования, а не доказанная привязка Figma.
- Растровые файлы доступны, только если включено их сохранение и Figma загрузила их при чтении.
- Сервер слушает loopback и принимает сообщения только от закреплённого ID расширения.
  Cookies, токены Figma и исходящие сообщения вкладки не передаются; API изменения макета нет.

## Пакет релиза

После сборки `pnpm package:kiwi` создаёт `artifacts/figlens`.
Версии Chrome-расширения и Codex-плагина должны совпадать.
`node scripts/prepare-kiwi-release.mjs minor` обновляет обе версии; слияние PR версии в `main`
запускает публикацию ZIP и SHA-256 через `kiwi-release.yml`.
