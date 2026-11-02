import { Decompress } from 'fzstd';

/** Track frame boundaries without depending on fzstd's private decoder state. */
class ZstdFrameBoundary {
  private header: number[] = [];
  private headerSize = 5;
  private phase: 'frame' | 'block' | 'payload' | 'checksum' = 'frame';
  private remaining = 0;
  private lastBlock = false;
  private checksum = false;

  get complete(): boolean {
    return this.phase === 'frame' && this.header.length === 0;
  }

  push(input: Uint8Array): void {
    let offset = 0;
    while (offset < input.length || this.phase === 'payload') {
      if (this.phase === 'payload' || this.phase === 'checksum') {
        const size = Math.min(this.remaining, input.length - offset);
        offset += size;
        this.remaining -= size;
        if (this.remaining !== 0) return;
        if (this.phase === 'payload' && this.lastBlock && this.checksum) {
          this.phase = 'checksum';
          this.remaining = 4;
        } else {
          this.phase = this.phase === 'payload' && !this.lastBlock ? 'block' : 'frame';
          this.headerSize = this.phase === 'frame' ? 5 : 3;
        }
        continue;
      }
      while (this.header.length < this.headerSize && offset < input.length) {
        this.header.push(input[offset++]!);
      }
      if (this.header.length < this.headerSize) return;
      if (this.phase === 'frame') {
        const descriptor = this.header[4]!;
        if (this.headerSize === 5) {
          if (
            this.header[0] !== 0x28 ||
            this.header[1] !== 0xb5 ||
            this.header[2] !== 0x2f ||
            this.header[3] !== 0xfd
          ) {
            throw new Error('Invalid Zstandard frame header');
          }
          const singleSegment = (descriptor & 0x20) !== 0;
          const sizeFlag = descriptor >>> 6;
          const dictionarySize = [0, 1, 2, 4][descriptor & 3]!;
          const contentSize = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag;
          this.headerSize = 5 + (singleSegment ? 0 : 1) + dictionarySize + contentSize;
          if (this.header.length < this.headerSize) continue;
        }
        this.checksum = (descriptor & 4) !== 0;
        this.phase = 'block';
      } else {
        const block = this.header[0]! | (this.header[1]! << 8) | (this.header[2]! << 16);
        const type = (block >>> 1) & 3;
        if (type === 3) throw new Error('Invalid Zstandard block type');
        this.lastBlock = (block & 1) !== 0;
        this.remaining = type === 1 ? 1 : block >>> 3;
        this.phase = 'payload';
      }
      this.header = [];
      this.headerSize = 3;
    }
  }
}

/** Figma flushes complete Kiwi messages into one connection-long Zstandard frame. */
export class ZstdMessageStream {
  private readonly boundary = new ZstdFrameBoundary();
  private chunks: Uint8Array[] = [];
  private readonly decoder = new Decompress(chunk => this.chunks.push(chunk));

  get complete(): boolean {
    return this.boundary.complete;
  }

  push(input: Uint8Array): Uint8Array {
    this.chunks = [];
    this.boundary.push(input);
    this.decoder.push(input);
    if (this.boundary.complete) this.decoder.push(new Uint8Array(0), true);
    const bytes = new Uint8Array(this.chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    return bytes;
  }
}
