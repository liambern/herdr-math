import { deflateSync } from 'node:zlib';

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, 'ascii');
  data.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

// PNG scanlines with filter None; zlib compresses the large transparent regions.
export function encodePNG(pixels, width, height) {
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    scanlines.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6; // 8-bit RGBA, no interlacing.
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

const encoded = new WeakMap();
export function wireFrame(frame) {
  if (encoded.has(frame)) return encoded.get(frame);
  const blocks = frame.placements;
  // Unknown frames retain their original placement; renderer frames can be cropped.
  let col = 0, row = 0, cols = frame.cols, rows = frame.rows;
  if (blocks?.length) {
    col = Math.min(...blocks.map(block => block.col));
    row = Math.min(...blocks.map(block => block.row));
    cols = Math.max(...blocks.map(block => block.col + block.cols)) - col;
    rows = Math.max(...blocks.map(block => block.row + block.rows)) - row;
  } else if (blocks) {
    const result = { data: encodePNG(Buffer.alloc(4), 1, 1), width: 1, height: 1, cols: 1, rows: 1, col: 0, row: 0 };
    encoded.set(frame, result);
    return result;
  }
  const cellWidth = frame.width / frame.cols, cellHeight = frame.height / frame.rows;
  const width = cols * cellWidth, height = rows * cellHeight;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((row * cellHeight + y) * frame.width + col * cellWidth) * 4;
    pixels.set(frame.pixels.subarray(start, start + width * 4), y * width * 4);
  }
  const result = { data: encodePNG(pixels, width, height), width, height, cols, rows, col, row };
  encoded.set(frame, result);
  return result;
}
