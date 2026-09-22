# FigLens

FigLens читает выбранный фрейм Figma из Chrome и передаёт его Codex, Cursor, Claude Code или другому
MCP-клиенту. Инструмент работает только на чтение, не использует Figma REST API и не требует запуска
Figma-плагина. Пользователь должен иметь обычный доступ к открытому файлу.

## Установка готового релиза

Требуются Windows, Chrome 116+ и Node.js 24.11+ из ветки 24 либо Node.js 26+.

1. Скачайте `figlens-vX.Y.Z.zip` и `.sha256` из
   [GitHub Releases](https://github.com/DenisPapushaJava/figwright-kiwi-reader/releases/latest).
2. Распакуйте архив в постоянную папку и запустите:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

3. Откройте `chrome://extensions`, включите **Режим разработчика**, нажмите
   **Загрузить распакованное расширение** и выберите:

   ```text
   %LOCALAPPDATA%\FigwrightKiwi\extension
   ```

4. Перезапустите используемые MCP-клиенты.

По умолчанию установщик настраивает доступные Codex, Cursor и Claude Code. Нужные клиенты можно
указать явно:

```powershell
.\install.ps1 -Clients Codex
.\install.ps1 -Clients Cursor,ClaudeCode
```

## Использование

1. Откройте Figma в Chrome и выберите фрейм или слой.
2. Нажмите значок **FigLens** и выберите **Подключить макет**.
3. Дождитесь зелёного состояния готовности.
4. Попросите MCP-клиент прочитать выбранный узел. Например, в Codex:

   ```text
   @fk проверь подключение к Figma
   @fk прочитай выбранный фрейм
   @fk подготовь выбранный фрейм к реализации в текущем проекте
   ```

Для другого слоя нажмите **Считать заново**. Захват растровых изображений по умолчанию выключен;
включайте его только когда нужны фотографии или растровые заливки.

## Обновление и удаление

Для обновления запустите `install.ps1` из нового релиза, нажмите **Обновить** на карточке FigLens в
`chrome://extensions` и перезапустите MCP-клиенты.

Для полного удаления:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\FigwrightKiwi\uninstall.ps1"
```

## Диагностика и ограничения

- Состояние hub: <http://127.0.0.1:9225/health>.
- `LOCAL_MCP_OFFLINE`: перезапустите MCP-клиент и проверьте hub.
- `EXTENSION_RELOAD_REQUIRED`: обновите расширение в `chrome://extensions`.
- `CAPTURE_LIMIT_EXCEEDED`: выберите меньший фрейм или читайте экран по секциям.
- Kiwi — внутренний протокол Figma; после его изменения может потребоваться новый релиз.
- FigLens не читает cookies и токены Figma, не изменяет макет и не обходит права доступа.

Полная документация и исходный код:
[github.com/DenisPapushaJava/figwright-kiwi-reader](https://github.com/DenisPapushaJava/figwright-kiwi-reader).
