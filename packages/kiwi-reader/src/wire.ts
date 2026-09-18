import { decompress } from 'fzstd';
import { compileSchema, decodeBinarySchema } from 'kiwi-schema';

const FIG_WIRE_MAGIC = new TextEncoder().encode('fig-wire');
const ZSTD_MAGIC = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd);

export interface KiwiCodec {
  decodeMessage: (data: Uint8Array) => unknown;
}

export type DecodeResult =
  | { kind: 'schema' }
  | { kind: 'message'; message: unknown }
  | { kind: 'waiting-for-schema' }
  | { kind: 'ignored'; error: string };

const startsWith = (input: Uint8Array, prefix: Uint8Array): boolean =>
  prefix.every((byte, index) => input[index] === byte);

export const isFigWireFrame = (input: Uint8Array): boolean =>
  input.length >= 12 && startsWith(input, FIG_WIRE_MAGIC);

export const isZstdFrame = (input: Uint8Array): boolean =>
  input.length >= ZSTD_MAGIC.length && startsWith(input, ZSTD_MAGIC);

export const decodePayload = (payload: string): Uint8Array =>
  new Uint8Array(Buffer.from(payload, 'base64'));

/**
 * Stateful decoder for the frames Figma sends to its browser editor.
 *
 * The first `fig-wire` frame carries the binary Kiwi schema. Later binary frames use that exact
 * schema, so the reader follows Figma protocol changes without shipping a copied schema. Only
 * received frames are accepted by the browser extension; this class has no encoder or write path.
 */
export class KiwiWireDecoder {
  private codec: KiwiCodec | null = null;

  get ready(): boolean {
    return this.codec !== null;
  }

  reset(): void {
    this.codec = null;
  }

  ingestBase64(payload: string): DecodeResult {
    return this.ingest(decodePayload(payload));
  }

  ingest(input: Uint8Array): DecodeResult {
    try {
      if (isFigWireFrame(input)) {
        const compressedSchema = input.subarray(12);
        const schemaBytes = decompress(compressedSchema);
        const schema = decodeBinarySchema(schemaBytes);
        this.codec = compileSchema(schema) as KiwiCodec;
        return { kind: 'schema' };
      }

      if (this.codec === null) return { kind: 'waiting-for-schema' };

      const bytes = isZstdFrame(input) ? decompress(input) : input;
      return { kind: 'message', message: this.codec.decodeMessage(bytes) };
    } catch (error) {
      return { kind: 'ignored', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
