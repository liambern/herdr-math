import test from 'node:test';
import assert from 'node:assert/strict';
import { findInline } from '../src/inline.mjs';
import { renderFrame } from '../src/math.mjs';

test('inline delimiters support multiple expressions and Unicode cell positions', () => {
  const spans = findInline(String.raw`界 $x$ and \(y^2\).`);
  assert.deepEqual(spans.map(({ latex, col, cols }) => ({ latex, col, cols })), [
    { latex: 'x', col: 3, cols: 3 }, { latex: 'y^2', col: 11, cols: 7 },
  ]);
});

test('currency, escaped delimiters, code, and incomplete math stay text', () => {
  for (const text of [
    'Costs $5 and $10.', String.raw`Price \$5; literal \$x\$.`,
    '`$x$` and ``\\(x\\)``', '```tex\n$x$\n```', '~~~\n\\(x\\)\n~~~',
    'An unfinished $x', String.raw`An unfinished \(x`, '$$\n$x$\n',
    '$ spaced $', '$$x$$',
  ]) assert.equal(findInline(text).length, 0, text);
  assert.deepEqual(findInline('Cost $5 and $10; use $x$.').map(span => span.latex), ['x']);
  assert.deepEqual(findInline('`$literal$` then $x$.').map(span => span.latex), ['x']);
});

test('inline rendering never paints neighboring prose or other rows', () => {
  const text = 'Before $x$ and $y$ after.\nUnrelated prose.';
  const frame = renderFrame(text, 10, 22, 80);
  const spans = findInline(text);
  assert.equal(frame.placements.length, 2);
  assert(frame.placements.every(span => span.inline));
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const inside = y < 22 && spans.some(span => x >= span.col * 10 && x < (span.col + span.cols) * 10);
      const alpha = frame.pixels[(y * frame.width + x) * 4 + 3];
      if (!inside) assert.equal(alpha, 0, `unexpected coverage at ${x},${y}`);
    }
  }
});

test('oversized and invalid inline math fall back to source text', () => {
  for (const latex of [String.raw`\frac{\frac{a}{b}}{\frac{c}{d}}`, String.raw`\unknownMacro{x}`]) {
    assert.equal(renderFrame(`Value $${latex}$ here.`, 10, 22, 120).placements.length, 0);
  }
});

test('compact single-line displays render without a prescribed three-line template', () => {
  assert.equal(renderFrame('$$x$$', 10, 22, 80).placements.length, 1);
  const frame = renderFrame('Use $x$ here.\n\n$$\ny^2\n$$', 10, 22, 80);
  assert.equal(frame.placements.length, 2);
  assert.equal(frame.placements.filter(span => span.inline).length, 1);
});
