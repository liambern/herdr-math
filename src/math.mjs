import { findInline } from './inline.mjs';
import { Cache } from './cache.mjs';
import stringWidth from 'string-width';
import { Resvg } from '@resvg/resvg-js';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const cache = new Cache(4 * 1024 * 1024);
const tiles = new Cache(16 * 1024 * 1024);
const fenceMark = line => /^\s*(?:[•●⏺]\s+)?(`{3,}|~{3,})/.exec(line)?.[1];

// Read terminal rows, not Markdown offsets. Leading rows must not be trimmed.
export function findBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let fence;
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    const mark = fenceMark(line);
    if (mark) {
      if (!fence) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const start = /^(\s*(?:[•●⏺]\s+)?)(\$\$|\\\[|\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\})/.exec(line);
    if (!start) continue;
    const open = start[2];
    const end = open === '$$' ? '$$' : open === '\\[' ? '\\]' : `\\end{${start[3]}}`;
    const col = stringWidth(start[1]);
    const chunks = [line.slice(start[0].length)];
    let last = row;
    while (!chunks.at(-1).includes(end) && last + 1 < lines.length) {
      if (fenceMark(lines[last + 1])) break;
      chunks.push(lines[++last]);
    }
    const closing = chunks.at(-1).indexOf(end);
    if (closing < 0 || chunks.at(-1).slice(closing + end.length).trim()) continue;
    chunks[chunks.length - 1] = chunks.at(-1).slice(0, closing);
    const sourceRows = lines.slice(row, last + 1);
    // Never cover unrelated text to the left of a continuation row.
    if (sourceRows.slice(1).some(s => s.trim() && stringWidth(/^\s*/.exec(s)[0]) < col)) continue;
    let latex = chunks.join('\n').trim();
    if (start[3]) latex = `${open}${latex}${end}`;
    if (latex) blocks.push({
      latex, row, col, rows: last - row + 1,
      cols: Math.max(...sourceRows.map(stringWidth)) - col,
    });
    row = last;
  }
  return blocks;
}

function formula(latex, inline = false) {
  const key = JSON.stringify([latex, inline]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (latex.length > 16384) return null;
  let result = null;
  try {
    const document = mathjax.document('', {
      InputJax: new TeX({
        packages: AllPackages.filter(name => !['html', 'noerrors', 'noundefined'].includes(name)),
        tags: 'none',
        formatError: (_, error) => { throw error; },
      }),
      OutputJax: new SVG({ fontCache: 'none' }),
    });
    const html = adaptor.outerHTML(document.convert(latex, { display: !inline }));
    const svg = html.slice(html.indexOf('<svg'), html.lastIndexOf('</svg>') + 6);
    const width = Number(/width="([\d.]+)ex"/.exec(svg)?.[1]);
    const height = Number(/height="([\d.]+)ex"/.exec(svg)?.[1]);
    if (width > 0 && height > 0 && !svg.includes('data-mml-node="merror"')) {
      result = { svg, width, height };
    }
  } catch { /* Invalid or incomplete TeX remains readable as terminal text. */ }
  cache.set(key, result, 2 * (latex.length + (result?.svg.length ?? 0)));
  return result;
}

export function renderFrame(text, cellWidth, cellHeight, paneCols) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw new RangeError('Terminal text exceeds rendering limit.');
  if (![cellWidth, cellHeight].every(n => Number.isSafeInteger(n) && n > 0 && n <= 512)) throw new RangeError('Invalid terminal cell dimensions.');
  const lines = text.split('\n');
  const cols = paneCols ?? Math.max(1, ...lines.map(stringWidth));
  if (!Number.isSafeInteger(cols) || cols <= 0) throw new RangeError('Invalid pane width.');
  const rows = lines.length;
  const width = cols * cellWidth;
  const height = rows * cellHeight;
  if (width > 16384 || height > 16384 || width * height > 8 * 1024 * 1024) throw new RangeError('Terminal frame exceeds rendering limit.');
  const pixels = Buffer.alloc(width * height * 4);
  const placements = [];
  const displayBlocks = findBlocks(text);
  for (const block of [...displayBlocks, ...findInline(text, displayBlocks)]) {
    const inline = block.inline === true;
    const math = formula(block.latex, inline);
    if (!math) continue;
    if (block.col + block.cols > cols) continue;
    const availableWidth = (inline || paneCols === undefined ? block.cols : cols) * cellWidth;
    const h = block.rows * cellHeight;
    const baseScale = cellHeight * 0.5;
    const padding = block.rows === 1 ? 2 : 8;
    const scale = Math.min(baseScale, (availableWidth - padding) / math.width, (h - padding) / math.height);
    if (scale < baseScale * 0.75) continue;
    const mw = math.width * scale, mh = math.height * scale;
    const mathX = inline ? block.col * cellWidth + 1 : paneCols === undefined
      ? block.col * cellWidth + (availableWidth - mw) / 2
      : (width - mw) / 2;
    // Use a full-width band when the live pane width is known.
    const col = inline ? block.col : paneCols === undefined ? Math.min(block.col, Math.floor(mathX / cellWidth)) : 0;
    const endCol = inline ? block.col + block.cols : paneCols === undefined ? Math.max(block.col + block.cols, Math.ceil((mathX + mw) / cellWidth)) : cols;
    const w = (endCol - col) * cellWidth;
    const x = col * cellWidth, y = block.row * cellHeight;
    const tileKey = JSON.stringify([block.latex, inline, w, h, cellHeight, mathX - x]);
    let tile = tiles.get(tileKey);
    if (!tile) {
      const svg = math.svg.replace(/<svg[^>]*>/, tag => tag
        .replace(/\s(?:width|height|style)="[^"]*"/g, '')
        .replace('>', ` x="${mathX - x}" y="${(h - mh) / 2}" width="${mw}" height="${mh}">`));
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" color="#cdd6f4"><rect width="${w}" height="${h}" fill="#1e1e2e"/>${svg}</svg>`;
      tile = new Resvg(source, { font: { loadSystemFonts: /<text[\s>]/.test(source) } }).render().pixels;
      tiles.set(tileKey, tile, tile.length);
    }
    for (let row = 0; row < h; row++) {
      pixels.set(tile.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * width + x) * 4);
    }
    placements.push({ ...block, col, cols: endCol - col });
  }
  return { pixels, width, height, cols, rows, placements };
}
