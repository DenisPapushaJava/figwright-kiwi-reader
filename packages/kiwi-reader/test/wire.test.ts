import { zstdCompressSync } from 'node:zlib';

import { compileSchema, encodeBinarySchema, parseSchema } from 'kiwi-schema';
import { describe, expect, it } from 'vitest';

import { isFigWireFrame, isZstdFrame, KiwiWireDecoder } from '../src/wire.js';

describe('Kiwi wire detection', () => {
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
