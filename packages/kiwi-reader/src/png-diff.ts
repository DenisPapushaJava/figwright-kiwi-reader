import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

export interface PngDiffReport {
  width: number;
  height: number;
  totalPixels: number;
  changedPixels: number;
  changedRatio: number;
  tolerance: number;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  diffPath: string;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Buffer => {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  name.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return output;
};

export const encodeRgbaPng = (width: number, height: number, rgba: Uint8Array): Uint8Array => {
  if (width <= 0 || height <= 0 || rgba.byteLength !== width * height * 4) {
    throw new Error('Invalid RGBA image dimensions');
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rows[rowOffset] = 0;
    rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowOffset + 1);
  }
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array()),
  ]);
};

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

const decodePng = (png: Uint8Array): { width: number; height: number; rgba: Uint8Array } => {
  if (!SIGNATURE.every((byte, index) => png[index] === byte)) throw new Error('Input is not a PNG');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const data: Uint8Array[] = [];
  while (offset + 12 <= png.byteLength) {
    const length = view.getUint32(offset, false);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    if (offset + 12 + length > png.byteLength) throw new Error('Truncated PNG chunk');
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, false);
      height = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(4, false);
      if (body[8] !== 8 || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) {
        throw new Error('Only non-interlaced 8-bit PNGs are supported');
      }
      colorType = body[9] as number;
    }
    if (type === 'IDAT') data.push(body);
    if (type === 'IEND') break;
    offset += length + 12;
  }
  const channels =
    colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (width <= 0 || height <= 0 || width * height > 100_000_000 || channels === 0) {
    throw new Error(`Unsupported PNG color type ${colorType}`);
  }
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(data.map(item => Buffer.from(item))));
  if (inflated.byteLength !== height * (stride + 1)) throw new Error('Unexpected PNG data length');
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const input = y * (stride + 1);
    const filter = inflated[input] as number;
    for (let x = 0; x < stride; x++) {
      const encoded = inflated[input + 1 + x] as number;
      const left = x >= channels ? (raw[y * stride + x - channels] as number) : 0;
      const above = y > 0 ? (raw[(y - 1) * stride + x] as number) : 0;
      const upperLeft =
        y > 0 && x >= channels ? (raw[(y - 1) * stride + x - channels] as number) : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : filter === 4
                  ? paeth(left, above, upperLeft)
                  : -1;
      if (predictor < 0) throw new Error(`Unsupported PNG filter ${filter}`);
      raw[y * stride + x] = (encoded + predictor) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const source = pixel * channels;
    const target = pixel * 4;
    if (colorType === 6 || colorType === 2) {
      rgba[target] = raw[source] as number;
      rgba[target + 1] = raw[source + 1] as number;
      rgba[target + 2] = raw[source + 2] as number;
      rgba[target + 3] = colorType === 6 ? (raw[source + 3] as number) : 255;
    } else {
      const gray = raw[source] as number;
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = colorType === 4 ? (raw[source + 1] as number) : 255;
    }
  }
  return { width, height, rgba };
};

export const comparePngFiles = async (options: {
  referencePath: string;
  actualPath: string;
  diffPath: string;
  tolerance?: number;
}): Promise<PngDiffReport> => {
  const tolerance = options.tolerance ?? 0;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255)
    throw new Error('tolerance must be an integer from 0 to 255');
  const [reference, actual] = await Promise.all([
    readFile(options.referencePath).then(decodePng),
    readFile(options.actualPath).then(decodePng),
  ]);
  if (reference.width !== actual.width || reference.height !== actual.height) {
    throw new Error(
      `PNG dimensions differ: reference ${reference.width}x${reference.height}, actual ${actual.width}x${actual.height}`,
    );
  }
  const diff = new Uint8Array(reference.rgba.byteLength);
  let changedPixels = 0;
  let minX = reference.width;
  let minY = reference.height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < reference.width * reference.height; pixel++) {
    const offset = pixel * 4;
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      if (
        Math.abs(
          (reference.rgba[offset + channel] as number) - (actual.rgba[offset + channel] as number),
        ) > tolerance
      )
        changed = true;
    }
    if (changed) {
      changedPixels++;
      const x = pixel % reference.width;
      const y = Math.floor(pixel / reference.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      diff.set([255, 0, 80, 255], offset);
    } else {
      const gray = Math.round(
        ((reference.rgba[offset] as number) +
          (reference.rgba[offset + 1] as number) +
          (reference.rgba[offset + 2] as number)) /
          3,
      );
      diff.set([gray, gray, gray, 72], offset);
    }
  }
  const diffPath = resolve(options.diffPath);
  await mkdir(dirname(diffPath), { recursive: true });
  await writeFile(diffPath, encodeRgbaPng(reference.width, reference.height, diff));
  const totalPixels = reference.width * reference.height;
  return {
    width: reference.width,
    height: reference.height,
    totalPixels,
    changedPixels,
    changedRatio: changedPixels / totalPixels,
    tolerance,
    boundingBox:
      changedPixels === 0
        ? null
        : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    diffPath,
  };
};
