import { once } from 'node:events';
import { constants, createZstdCompress, zstdCompressSync } from 'node:zlib';

import { compileSchema, encodeBinarySchema, parseSchema } from 'kiwi-schema';
import { describe, expect, it } from 'vitest';

import { isFigWireFrame, isZstdFrame, KiwiWireDecoder } from '../src/wire.js';

const streamingMessages = async (messages: Uint8Array[]): Promise<Uint8Array[]> => {
  const compressor = createZstdCompress();
  let chunks: Buffer[] = [];
  const result: Uint8Array[] = [];
  compressor.on('data', (chunk: Buffer) => chunks.push(chunk));
  for (const message of messages.slice(0, -1)) {
    compressor.write(message);
    // oxlint-disable-next-line no-await-in-loop -- Each websocket message ends at a compression flush.
    await new Promise<void>(resolve => {
      compressor.flush(constants.ZSTD_e_flush, resolve);
    });
    result.push(Buffer.concat(chunks));
    chunks = [];
  }
  compressor.end(messages.at(-1));
  await once(compressor, 'end');
  result.push(Buffer.concat(chunks));
  return result;
};

describe('Kiwi wire detection', () => {
  it('decodes flushed messages from one Zstandard stream and keeps legacy raw messages working', async () => {
    const schema = parseSchema(`
      message NodeChange {
        string name = 1;
      }
      message Message {
        NodeChange[] nodeChanges = 1;
      }
    `);
    const codec = compileSchema(schema) as { encodeMessage: (value: unknown) => Uint8Array };
    const schemaBytes = zstdCompressSync(encodeBinarySchema(schema));
    const schemaFrame = new Uint8Array(12 + schemaBytes.length);
    schemaFrame.set(new TextEncoder().encode('fig-wire'));
    schemaFrame.set(schemaBytes, 12);
    const names = ['First page', 'Second screen', 'Last component'];
    const messages = names.map(name => ({ nodeChanges: [{ name }] }));
    const encoded = messages.map(message => codec.encodeMessage(message));
    const packets = await streamingMessages(encoded);
    expect(isZstdFrame(packets[0]!)).toBe(true);
    expect(isZstdFrame(packets[1]!)).toBe(false);
    const decoder = new KiwiWireDecoder();
    expect(decoder.ingest(schemaFrame)).toEqual({ kind: 'schema' });
    for (const [i, packet] of packets.entries()) {
      expect(decoder.ingest(packet)).toEqual({ kind: 'message', message: messages[i] });
      expect(decoder.ingest(zstdCompressSync(codec.encodeMessage({})))).toEqual({
        kind: 'message',
        message: {},
      });
    }
    expect(decoder.ingest(encoded[0]!)).toEqual({ kind: 'message', message: messages[0] });
    expect(decoder.ingest(zstdCompressSync(encoded[1]!))).toEqual({
      kind: 'message',
      message: messages[1],
    });
    decoder.ingest(packets[0]!);
    decoder.reset();
    expect(decoder.ready).toBe(false);
    expect(decoder.ingest(schemaFrame)).toEqual({ kind: 'schema' });
    expect(decoder.ingest(encoded[0]!)).toEqual({ kind: 'message', message: messages[0] });
  });

  it('recognizes the schema prelude', () => {
    const bytes = new TextEncoder().encode('fig-wire');
    const frame = new Uint8Array(12);
    frame.set(bytes);
    expect(isFigWireFrame(frame)).toBe(true);
    expect(isFigWireFrame(new TextEncoder().encode('not-wire'))).toBe(false);
  });

  it('recognizes zstd frames', () => {
    expect(isZstdFrame(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 1))).toBe(true);
    expect(isZstdFrame(Uint8Array.of(0x1f, 0x8b, 0x08))).toBe(false);
  });

  it('compiles the transmitted schema and decodes a message', () => {
    const schema = parseSchema(`
      message Guid {
        int sessionID = 1;
        int localID = 2;
      }
      message NodeChange {
        Guid guid = 1;
        string name = 2;
      }
      message Message {
        NodeChange[] nodeChanges = 1;
      }
    `);
    const codec = compileSchema(schema) as {
      encodeMessage: (value: unknown) => Uint8Array;
    };
    const schemaBytes = zstdCompressSync(encodeBinarySchema(schema));
    const schemaFrame = new Uint8Array(12 + schemaBytes.length);
    schemaFrame.set(new TextEncoder().encode('fig-wire'));
    schemaFrame.set(schemaBytes, 12);

    const decoder = new KiwiWireDecoder();
    expect(decoder.ingest(schemaFrame)).toEqual({ kind: 'schema' });

    const messageBytes = codec.encodeMessage({
      nodeChanges: [{ guid: { sessionID: 6, localID: 140 }, name: 'Target' }],
    });
    const result = decoder.ingest(zstdCompressSync(messageBytes));
    expect(result).toMatchObject({
      kind: 'message',
      message: { nodeChanges: [{ guid: { sessionID: 6, localID: 140 }, name: 'Target' }] },
    });
  });

  it('preserves Kiwi mixed-text style ids and their explicit override ids', () => {
    const schema = parseSchema(`
      struct FontName {
        string family;
        string style;
      }
      message TextData {
        string characters = 1;
        uint[] characterStyleIDs = 2;
        NodeChange[] styleOverrideTable = 3;
      }
      message NodeChange {
        uint styleID = 1;
        float fontSize = 2;
        FontName fontName = 3;
        TextData textData = 4;
      }
      message Message {
        NodeChange[] nodeChanges = 1;
      }
    `);
    const codec = compileSchema(schema) as {
      encodeMessage: (value: unknown) => Uint8Array;
    };
    const schemaBytes = zstdCompressSync(encodeBinarySchema(schema));
    const schemaFrame = new Uint8Array(12 + schemaBytes.length);
    schemaFrame.set(new TextEncoder().encode('fig-wire'));
    schemaFrame.set(schemaBytes, 12);

    const decoder = new KiwiWireDecoder();
    expect(decoder.ingest(schemaFrame)).toEqual({ kind: 'schema' });

    const messageBytes = codec.encodeMessage({
      nodeChanges: [
        {
          fontSize: 16,
          fontName: { family: 'Inter', style: 'Regular' },
          textData: {
            characters: 'Mixed',
            characterStyleIDs: [0, 0, 7, 7, 7],
            styleOverrideTable: [
              {
                styleID: 7,
                fontSize: 20,
                fontName: { family: 'Inter', style: 'Bold' },
              },
            ],
          },
        },
      ],
    });
    expect(decoder.ingest(zstdCompressSync(messageBytes))).toMatchObject({
      kind: 'message',
      message: {
        nodeChanges: [
          {
            textData: {
              characters: 'Mixed',
              characterStyleIDs: [0, 0, 7, 7, 7],
              styleOverrideTable: [
                {
                  styleID: 7,
                  fontSize: 20,
                  fontName: { family: 'Inter', style: 'Bold' },
                },
              ],
            },
          },
        ],
      },
    });
  });

  it('identifies an incompatible schema frame', () => {
    const frame = new Uint8Array(16);
    frame.set(new TextEncoder().encode('fig-wire'));
    frame.set([1, 2, 3, 4], 12);

    expect(new KiwiWireDecoder().ingest(frame)).toMatchObject({
      kind: 'ignored',
      source: 'schema',
    });
  });
});
