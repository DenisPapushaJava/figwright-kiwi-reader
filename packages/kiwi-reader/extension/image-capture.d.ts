export const MAX_IMAGE_BODY_BYTES: number;
export const MAX_IMAGE_BRIDGE_BUFFER_BYTES: number;
export const imageResponseMetadata: (params: unknown) => {
  requestId: string;
  mimeType: string;
  url: string;
} | null;
export const decodedBodySize: (body: unknown, base64Encoded: boolean) => number;
export const canForwardImageBody: (
  body: unknown,
  base64Encoded: boolean,
  bridgeBufferedAmount: number,
) => boolean;
export const captureReloadOptions: (captureImages: boolean) => {
  ignoreCache: boolean;
};
