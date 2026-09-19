export const MAX_IMAGE_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_BRIDGE_BUFFER_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;

export const imageResponseMetadata = params => {
  const requestId = params?.requestId;
  const mimeType = params?.response?.mimeType;
  const url = params?.response?.url;
  if (
    typeof requestId !== 'string' ||
    typeof mimeType !== 'string' ||
    !IMAGE_MIME.test(mimeType) ||
    typeof url !== 'string' ||
    !/^https?:\/\//i.test(url)
  ) {
    return null;
  }
  return { requestId, mimeType, url };
};

export const decodedBodySize = (body, base64Encoded) => {
  if (typeof body !== 'string') return Number.POSITIVE_INFINITY;
  if (!base64Encoded) return new TextEncoder().encode(body).byteLength;
  const compactLength = body.replaceAll(/\s/g, '').length;
  if (compactLength === 0) return 0;
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compactLength * 3) / 4) - padding);
};

export const canForwardImageBody = (body, base64Encoded, bridgeBufferedAmount) =>
  decodedBodySize(body, base64Encoded) <= MAX_IMAGE_BODY_BYTES &&
  bridgeBufferedAmount <= MAX_IMAGE_BRIDGE_BUFFER_BYTES;

export const captureReloadOptions = captureImages => ({
  ignoreCache: captureImages === true,
});
