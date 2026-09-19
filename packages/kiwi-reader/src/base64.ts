export type BoundedBase64DecodeResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'invalid' | 'size' };

const isWhitespace = (code: number): boolean =>
  code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;

const isAlphabet = (code: number): boolean =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  (code >= 48 && code <= 57) ||
  code === 43 ||
  code === 47;

/** Decode standard Base64 without applying a backtracking regexp to large browser payloads. */
export const decodeBoundedBase64 = (
  payload: string,
  maxBytes: number,
): BoundedBase64DecodeResult => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { ok: false, reason: 'size' };

  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  let compactLength = 0;
  let previousCode = 0;
  let lastCode = 0;

  for (let index = 0; index < payload.length; index++) {
    const code = payload.charCodeAt(index);
    if (isWhitespace(code)) continue;
    compactLength++;
    if (compactLength > maxEncodedLength) return { ok: false, reason: 'size' };
    previousCode = lastCode;
    lastCode = code;
  }

  if (compactLength % 4 !== 0) return { ok: false, reason: 'invalid' };

  let padding = 0;
  if (lastCode === 61) padding++;
  if (lastCode === 61 && previousCode === 61) padding++;
  const dataLength = compactLength - padding;
  let logicalIndex = 0;
  for (let index = 0; index < payload.length; index++) {
    const code = payload.charCodeAt(index);
    if (isWhitespace(code)) continue;
    if (logicalIndex < dataLength ? !isAlphabet(code) : code !== 61) {
      return { ok: false, reason: 'invalid' };
    }
    logicalIndex++;
  }

  const decodedLength = (compactLength / 4) * 3 - padding;
  if (decodedLength > maxBytes) return { ok: false, reason: 'size' };
  const bytes = Uint8Array.from(Buffer.from(payload, 'base64'));
  return bytes.byteLength === decodedLength
    ? { ok: true, bytes }
    : { ok: false, reason: 'invalid' };
};
