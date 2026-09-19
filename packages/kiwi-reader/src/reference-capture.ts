import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { decodeBoundedBase64 } from './base64.js';

export interface BrowserReferenceCapture {
  png: Uint8Array;
  viewport: {
    width: number;
    height: number;
    pageX: number;
    pageY: number;
  };
}

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const MAX_REFERENCE_BYTES = 32 * 1024 * 1024;

export const decodeReferencePng = (payload: string): Uint8Array => {
  const result = decodeBoundedBase64(payload, MAX_REFERENCE_BYTES);
  if (!result.ok) {
    throw new Error(
      result.reason === 'size' ? 'REFERENCE_SIZE_OUT_OF_RANGE' : 'REFERENCE_INVALID_BASE64',
    );
  }
  const png = result.bytes;
  if (png.byteLength < 24) {
    throw new Error('REFERENCE_SIZE_OUT_OF_RANGE');
  }
  if (!PNG_SIGNATURE.every((byte, index) => png[index] === byte)) {
    throw new Error('REFERENCE_NOT_PNG');
  }
  return png;
};

export const pngDimensions = (png: Uint8Array): { width: number; height: number } => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) throw new Error('REFERENCE_INVALID_DIMENSIONS');
  return { width, height };
};

const atomicWrite = async (path: string, data: string | Uint8Array): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
};

export const saveReferenceCapture = async (options: {
  capture: BrowserReferenceCapture;
  outPath: string;
  fileKey: string;
  tabId: number;
  selectedNodeId: string | null;
}): Promise<{ imagePath: string; metadataPath: string; width: number; height: number }> => {
  const imagePath = resolve(options.outPath);
  if (!imagePath.toLowerCase().endsWith('.png')) {
    throw new Error('Reference output path must end with .png');
  }
  await mkdir(dirname(imagePath), { recursive: true });
  const dimensions = pngDimensions(options.capture.png);
  const metadataPath = `${imagePath}.json`;
  await atomicWrite(imagePath, options.capture.png);
  await atomicWrite(
    metadataPath,
    `${JSON.stringify(
      {
        schemaVersion: 'figwright-kiwi-reference@1',
        source: {
          kind: 'figma-browser-viewport',
          fileKey: options.fileKey,
          tabId: options.tabId,
          selectedNodeId: options.selectedNodeId,
        },
        screenshot: dimensions,
        viewport: options.capture.viewport,
        cropConfidence: 'viewport-only',
      },
      null,
      2,
    )}\n`,
  );
  return { imagePath, metadataPath, ...dimensions };
};
