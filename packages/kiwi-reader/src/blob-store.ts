import { createHash } from 'node:crypto';

type UnknownRecord = Record<string, unknown>;

export const CAPTURED_BLOB_REFS = Symbol('figwright.kiwi.blobRefs');

export interface CapturedBlobStats {
  received: number;
  retained: number;
  deduplicated: number;
  rejected: number;
  unresolvedReferences: number;
  bytes: number;
}

export interface CapturedBlobStoreOptions {
  maxBlobBytes?: number;
  maxTotalBytes?: number;
  maxBlobs?: number;
}

const DEFAULT_MAX_BLOB_BYTES = 48 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_BLOBS = 100_000;

const record = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const byteArray = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (
    Array.isArray(value) &&
    value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return Uint8Array.from(value as number[]);
  }
  const source = record(value);
  if (source === null) return null;
  return byteArray(source.bytes ?? source.data);
};

const isBlobIndexField = (key: string): boolean =>
  key === 'commandsBlob' || key === 'vectorNetworkBlob';

const setBlobRef = (target: UnknownRecord, field: string, ref: string): void => {
  const propertyTarget = target as Record<PropertyKey, unknown>;
  const current = propertyTarget[CAPTURED_BLOB_REFS];
  const refs = record(current) ?? {};
  refs[field] = ref;
  if (current === undefined) {
    Object.defineProperty(target, CAPTURED_BLOB_REFS, {
      configurable: true,
      enumerable: true,
      value: refs,
      writable: true,
    });
  }
};

/**
 * Session-scoped storage for message-local Kiwi blobs.
 *
 * Kiwi node properties store numeric indices into the `blobs[]` array of the message that carried
 * that property. Scenegraph merging destroys that message boundary, so references are stabilized
 * before the node change is merged. The symbol metadata survives object spreads while remaining
 * absent from JSON and the public SerializedNode contract.
 */
export class CapturedBlobStore {
  private readonly maxBlobBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxBlobs: number;
  private readonly blobs = new Map<string, Uint8Array>();
  private counters: CapturedBlobStats = {
    received: 0,
    retained: 0,
    deduplicated: 0,
    rejected: 0,
    unresolvedReferences: 0,
    bytes: 0,
  };

  constructor(options: CapturedBlobStoreOptions = {}) {
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxBlobs = options.maxBlobs ?? DEFAULT_MAX_BLOBS;
  }

  get stats(): CapturedBlobStats {
    return { ...this.counters };
  }

  resolve(ref: string): Uint8Array | null {
    const value = this.blobs.get(ref);
    return value === undefined ? null : value.slice();
  }

  captureMessage(message: unknown): void {
    const source = record(message);
    if (source === null || !Array.isArray(source.blobs)) return;

    const refs = source.blobs.map(blob => this.retain(blob));
    const seen = new Set<object>();
    const visit = (value: unknown): void => {
      if (typeof value !== 'object' || value === null || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const item = value as UnknownRecord;
      for (const [key, child] of Object.entries(item)) {
        if (isBlobIndexField(key) && Number.isInteger(child)) {
          const index = child as number;
          const ref = index >= 0 ? refs[index] : undefined;
          if (ref === undefined || ref === null) this.counters.unresolvedReferences++;
          else setBlobRef(item, key, ref);
        }
        if (key !== 'blobs') visit(child);
      }
    };

    visit(source.nodeChanges);
  }

  clear(): void {
    this.blobs.clear();
    this.counters = {
      received: 0,
      retained: 0,
      deduplicated: 0,
      rejected: 0,
      unresolvedReferences: 0,
      bytes: 0,
    };
  }

  private retain(value: unknown): string | null {
    this.counters.received++;
    const bytes = byteArray(value);
    if (bytes === null || bytes.byteLength > this.maxBlobBytes) {
      this.counters.rejected++;
      return null;
    }

    const ref = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (this.blobs.has(ref)) {
      this.counters.deduplicated++;
      return ref;
    }
    if (
      this.blobs.size >= this.maxBlobs ||
      this.counters.bytes + bytes.byteLength > this.maxTotalBytes
    ) {
      this.counters.rejected++;
      return null;
    }

    const retained = bytes.slice();
    this.blobs.set(ref, retained);
    this.counters.retained++;
    this.counters.bytes += retained.byteLength;
    return ref;
  }
}

export const capturedBlobRef = (value: unknown, field: string): string | null => {
  const source = record(value) as (UnknownRecord & Record<PropertyKey, unknown>) | null;
  const refs = record(source?.[CAPTURED_BLOB_REFS]);
  return typeof refs?.[field] === 'string' ? refs[field] : null;
};
