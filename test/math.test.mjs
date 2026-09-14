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
  assert.equal(frame.png.subarray(1, 4).toString(), 'PNG');
  assert.equal(renderFrame('$$\n\\notacommand{x}\n$$', 10, 22).placements.length, 0);
  assert.equal(renderFrame('$$\\frac{a}{b}$$', 10, 22).placements.length, 0);
  renderFrame('$$\n\\def\\privateMacro{z}\\privateMacro\n$$', 10, 22);
  assert.equal(renderFrame('$$\n\\privateMacro\n$$', 10, 22).placements.length, 0);
});
