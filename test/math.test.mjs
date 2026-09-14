import test from 'node:test';
import assert from 'node:assert/strict';
import { findBlocks, renderFrame } from '../src/math.mjs';

const equation = String.raw`$$
E = \frac{\langle\Psi|H|\Psi\rangle}{\langle\Psi|\Psi\rangle}
$$`;

test('positions match terminal rows and indented source cells', () => {
  const text = '\n\nIntroduction\n' + equation.split('\n').map(s => '  ' + s).join('\n') + '\nConclusion';
  const [block] = findBlocks(text);
  assert.equal(block.row, 3);
  assert.equal(block.col, 2);
  assert.equal(block.rows, 3);
  assert.equal(block.latex, equation.split('\n')[1]);
});

test('code, inline, incomplete blocks and prose after a delimiter stay text', () => {
  for (const text of ['```tex\n' + equation + '\n```', 'The value is $x^2$.', '$$\nx^2', '$$x^2$$ is a formula']) {
    assert.equal(findBlocks(text).length, 0);
  }
  assert.equal(findBlocks('⏺ ```tex\n' + equation + '\n```').length, 0);
  assert.equal(findBlocks('$$\nx^2\n```\n$$\n```').length, 0);
  assert.equal(findBlocks('⏺ $$\n  x^2\n  $$').length, 0);
});

test('brackets, environments and multiple equations', () => {
  const text = String.raw`\[
x^2 + y^2 = z^2
\]

\begin{align*}
a &= b + c \\
d &= e + f
\end{align*}`;
  const blocks = findBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].row, 4);
  assert.match(blocks[1].latex, /^\\begin\{align\*\}/);
});

test('renders a fraction at real cell scale and preserves invalid or cramped source', () => {
  const frame = renderFrame(equation, 10, 22);
  assert.equal(frame.placements.length, 1);
  assert.equal(frame.height, 66);
  assert.equal(frame.pixels.length, frame.width * frame.height * 4);
  assert(frame.pixels.some(byte => byte !== 0));
  assert.equal(renderFrame('$$\n\\notacommand{x}\n$$', 10, 22).placements.length, 0);
  assert.equal(renderFrame('$$\\frac{a}{b}$$', 10, 22).placements.length, 0);
  renderFrame('$$\n\\def\\privateMacro{z}\\privateMacro\n$$', 10, 22);
  assert.equal(renderFrame('$$\n\\privateMacro\n$$', 10, 22).placements.length, 0);
});

test('invalid geometry and excessive frames are rejected before rasterization', () => {
  for (const size of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => renderFrame('text', size, 20), RangeError);
  }
  assert.throws(() => renderFrame('x'.repeat(20000), 10, 20), RangeError);
  assert.throws(() => renderFrame('x'.repeat(1024 * 1024 + 1), 10, 20), RangeError);
});

test('cached equation pixels remain identical after moving to a new row', () => {
  const first = renderFrame(equation, 10, 22);
  const moved = renderFrame('\n' + equation, 10, 22);
  assert.deepEqual(moved.pixels.subarray(first.width * 22 * 4), first.pixels);
  assert(moved.pixels.subarray(0, first.width * 22 * 4).every(byte => byte === 0));
});

test('different source widths share the pane center and recenter after resizing', () => {
  const center = frame => {
    let left = frame.width, right = -1;
    for (let i = 0; i < frame.pixels.length; i += 4) {
      // Light glyph pixels, excluding the dark source-covering rectangle.
      if (frame.pixels[i] > 100 && frame.pixels[i + 3] > 0) {
        const x = (i / 4) % frame.width;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    assert(right >= left, 'equation must contain rendered glyphs');
    return (left + right) / 2;
  };
  for (const cols of [80, 120]) {
    for (const latex of ['x', String.raw`\nabla\cdot\mathbf{B}=0`]) {
      const frame = renderFrame('$$\n' + latex + '\n$$', 10, 22, cols);
      assert.equal(frame.cols, cols);
      assert(Math.abs(center(frame) - frame.width / 2) < 3, 'glyphs must center on the pane');
    }
  }
});

test('equation backgrounds span the pane without covering surrounding rows', () => {
  for (const cols of [80, 120]) {
    const frame = renderFrame('\n  $$\n  x^2\n  $$\n', 10, 22, cols);
    assert.equal(frame.placements[0].col, 0);
    assert.equal(frame.placements[0].cols, cols);
    const pixel = (x, y) => frame.pixels.subarray((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4);
    for (let y = 22; y < 88; y++) {
      assert.deepEqual(pixel(0, y), Buffer.from([30, 30, 46, 255]));
      assert.deepEqual(pixel(frame.width - 1, y), Buffer.from([30, 30, 46, 255]));
    }
    assert.equal(pixel(0, 0)[3], 0);
    assert.equal(pixel(frame.width - 1, 88)[3], 0);
  }
});

test('multiline parsing preserves literal separators without guessing', () => {
  const tex = String.raw`\begin{align*}
a &= b \\
c &= d
\end{align*}`;
  const markdown = tex.replaceAll('\\\\\n', '\\\\\\\\\n');
  // CommonMark consumes each pair of backslashes as one literal backslash.
  const terminal = markdown.replaceAll('\\\\', '\\');
  assert.equal(terminal, tex);
  assert.equal(findBlocks(terminal)[0].latex, findBlocks(tex)[0].latex);
  const loneSlash = tex.replaceAll('\\\\\n', '\\\n');
  assert.notEqual(findBlocks(loneSlash)[0].latex, findBlocks(tex)[0].latex);
  assert(findBlocks(loneSlash)[0].latex.includes('b \\\n'));
  assert.equal(renderFrame(terminal, 10, 21, 100).placements.length, 1);
});
