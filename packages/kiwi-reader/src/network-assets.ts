import { createHash } from 'node:crypto';

export interface CapturedNetworkAsset {
  sha1: string;
  sha256: string;
  mimeType: string;
  url: string;
  bytes: Uint8Array;
}

export interface CapturedNetworkAssetStats {
  received: number;
  retained: number;
  deduplicated: number;
  rejected: number;
  bytes: number;
}

export interface CapturedNetworkAssetStoreOptions {
  maxAssetBytes?: number;
  maxTotalBytes?: number;
  maxAssets?: number;
}

const DEFAULT_MAX_ASSET_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ASSETS = 2_000;
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const decode = (payload: string, base64Encoded: boolean): Uint8Array | null => {
  if (!base64Encoded) return new TextEncoder().encode(payload);
  const compact = payload.replaceAll(/\s/g, '');
  if (!BASE64.test(compact)) return null;
  return Uint8Array.from(Buffer.from(compact, 'base64'));
};

/** Bounded, session-scoped image response cache populated by Chrome DevTools Protocol. */
export class CapturedNetworkAssetStore {
  private readonly maxAssetBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxAssets: number;
  private readonly assets = new Map<string, CapturedNetworkAsset>();
  private readonly hashes = new Map<string, string>();
  private counters: CapturedNetworkAssetStats = {
    received: 0,
    retained: 0,
    deduplicated: 0,
    rejected: 0,
    bytes: 0,
  };

  constructor(options: CapturedNetworkAssetStoreOptions = {}) {
    this.maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxAssets = options.maxAssets ?? DEFAULT_MAX_ASSETS;
  }

  get stats(): CapturedNetworkAssetStats {
    return { ...this.counters };
  }

  ingest(input: {
    url: string;
    mimeType: string;
    payload: string;
    base64Encoded: boolean;
  }): CapturedNetworkAsset | null {
    this.counters.received++;
    if (!IMAGE_MIME.test(input.mimeType)) return this.reject();
    const bytes = decode(input.payload, input.base64Encoded);
    if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > this.maxAssetBytes) {
      return this.reject();
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = this.assets.get(sha256);
    if (existing !== undefined) {
      this.counters.deduplicated++;
      return { ...existing, bytes: existing.bytes.slice() };
    }
    if (
      this.assets.size >= this.maxAssets ||
      this.counters.bytes + bytes.byteLength > this.maxTotalBytes
    ) {
      return this.reject();
    }
    const sha1 = createHash('sha1').update(bytes).digest('hex');
    const asset: CapturedNetworkAsset = {
      sha1,
      sha256,
      mimeType: input.mimeType.toLowerCase(),
      url: input.url,
      bytes: bytes.slice(),
    };
    this.assets.set(sha256, asset);
    this.hashes.set(sha1, sha256);
    this.hashes.set(sha256, sha256);
    this.counters.retained++;
    this.counters.bytes += bytes.byteLength;
    return { ...asset, bytes: asset.bytes.slice() };
  }

  resolveHash(hash: string): CapturedNetworkAsset | null {
    const key = this.hashes.get(hash.toLowerCase());
    const asset = key === undefined ? undefined : this.assets.get(key);
    return asset === undefined ? null : { ...asset, bytes: asset.bytes.slice() };
  }

  clear(): void {
    this.assets.clear();
    this.hashes.clear();
    this.counters = { received: 0, retained: 0, deduplicated: 0, rejected: 0, bytes: 0 };
  }

  private reject(): null {
    this.counters.rejected++;
    return null;
  }
}
