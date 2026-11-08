import test from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';
import { encodePNG } from '../src/png.mjs';
import { renderFrame } from '../src/math.mjs';

function decode(png, width, height) {
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`).render().pixels;
}

test('PNG bytes decode correctly in the native image renderer', () => {
  const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]);
  assert.deepEqual(decode(encodePNG(pixels, 2, 1), 2, 1), pixels);
});

test('each equation tile carries exactly its frame pixels and survives PNG transport', () => {
  const text = 'x'.repeat(120) + '\n'.repeat(20) + '  $$\n  E = mc^2\n  $$' + '\n'.repeat(40);
  const frame = renderFrame(text, 10, 21);
  const [placement] = frame.placements;
  const { pixels, width, height } = placement.tile;
  assert.equal(width, placement.cols * 10);
  assert.equal(height, placement.rows * 21);
  for (let y = 0; y < height; y++) {
    const start = ((placement.row * 21 + y) * frame.width + placement.col * 10) * 4;
    assert.deepEqual(pixels.subarray(y * width * 4, (y + 1) * width * 4), frame.pixels.subarray(start, start + width * 4));
  }
  const png = encodePNG(pixels, width, height);
  assert.deepEqual(decode(png, width, height), Buffer.from(pixels));
  assert(png.length < frame.pixels.length / 100, 'one equation transfers far less than the raw viewport');
});
