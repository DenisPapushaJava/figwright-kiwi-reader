import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const extensionFile = (name: string): Promise<string> =>
  readFile(join(import.meta.dirname, '..', 'extension', name), 'utf8');

describe('Kiwi extension capture options', () => {
  it('keeps raster capture opt-in and exposes the same control in popup and side panel', async () => {
    const [manifestText, background, popup, sidepanel, popupScript] = await Promise.all([
      extensionFile('manifest.json'),
      extensionFile('background.js'),
      extensionFile('popup.html'),
      extensionFile('sidepanel.html'),
      extensionFile('popup.js'),
    ]);
    const manifest = JSON.parse(manifestText) as { permissions?: string[] };

    expect(manifest.permissions).toContain('storage');
    expect(background).toContain('chrome.storage.local.get({ captureImages: false })');
    expect(background).toContain("message.type === 'set-capture-options'");
    expect(background).toContain('captureOptionsSupported: true');
    expect(popup).toContain('id="capture-images"');
    expect(sidepanel).toContain('id="capture-images"');
    expect(popup).not.toContain('id="capture-images" type="checkbox" checked');
    expect(popupScript).toContain("request('set-capture-options'");
    expect(popupScript).toContain("error.code = 'EXTENSION_RELOAD_REQUIRED'");
    expect(popupScript).toContain('currentState?.captureOptionsSupported !== true');
  });

  it('always answers an accepted runtime message if publishing its error state also fails', async () => {
    const background = await extensionFile('background.js');
    const reportGuard = background.slice(
      background.indexOf(
        'if (Number.isInteger(tabId)) {',
        background.indexOf('.catch(async error =>'),
      ),
      background.indexOf('sendResponse({ ok: false', background.indexOf('.catch(async error =>')),
    );

    expect(reportGuard).toContain('try {');
    expect(reportGuard).toContain('await reportError(tabId, code, error)');
    expect(reportGuard).toContain('catch (reportingError)');
  });

  it('uses the persistent native Chrome side panel rather than a detached window', async () => {
    const popupScript = await extensionFile('popup.js');
    expect(popupScript).toContain('chrome.sidePanel.open({ tabId })');
    expect(popupScript).not.toContain('chrome.windows.create');
  });
});
