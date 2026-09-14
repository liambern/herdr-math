import test from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';
import { encodePNG, wireFrame } from '../src/png.mjs';
import { renderFrame } from '../src/math.mjs';

function decode(png, width, height) {
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`).render().pixels;
}

test('PNG bytes decode correctly in the native image renderer', () => {
  const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]);
  assert.deepEqual(decode(encodePNG(pixels, 2, 1), 2, 1), pixels);
});

test('cropped transport preserves equation pixels and caches compressed bytes', () => {
  const text = 'x'.repeat(120) + '\n'.repeat(20) + '  $$\n  E = mc^2\n  $$' + '\n'.repeat(40);
  const frame = renderFrame(text, 10, 21);
  const wire = wireFrame(frame);
  assert.equal(wireFrame(frame), wire);
  assert.equal(wire.col, 2);
  assert.equal(wire.row, 20);
  const pixels = decode(wire.data, wire.width, wire.height);
  for (let y = 0; y < wire.height; y++) {
    const start = ((wire.row * 21 + y) * frame.width + wire.col * 10) * 4;
    assert.deepEqual(pixels.subarray(y * wire.width * 4, (y + 1) * wire.width * 4),
      frame.pixels.subarray(start, start + wire.width * 4));
  }
  assert(wire.data.length < frame.pixels.length / 100, 'representative viewport should transfer less than 1% of the raw bytes');
});

test('empty viewports send a tiny transparent image to clear the previous layer', () => {
  const wire = wireFrame(renderFrame('No equations', 10, 21));
  assert.equal(wire.width, 1);
  assert.equal(wire.height, 1);
  assert.deepEqual(decode(wire.data, 1, 1), Buffer.alloc(4));
});
