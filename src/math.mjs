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
const cache = new Map();
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

function formula(latex) {
  if (cache.has(latex)) return cache.get(latex);
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
    const html = adaptor.outerHTML(document.convert(latex, { display: true }));
    const svg = html.slice(html.indexOf('<svg'), html.lastIndexOf('</svg>') + 6);
    const width = Number(/width="([\d.]+)ex"/.exec(svg)?.[1]);
    const height = Number(/height="([\d.]+)ex"/.exec(svg)?.[1]);
    if (width > 0 && height > 0 && !svg.includes('data-mml-node="merror"')) {
      result = { svg, width, height };
    }
  } catch { /* Invalid or incomplete TeX remains readable as terminal text. */ }
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(latex, result);
  return result;
}

export function renderFrame(text, cellWidth, cellHeight) {
  const lines = text.split('\n');
  const cols = Math.max(1, ...lines.map(stringWidth));
  const rows = lines.length;
  const width = cols * cellWidth;
  const height = rows * cellHeight;
  const shapes = [];
  const placements = [];
  for (const block of findBlocks(text)) {
    const math = formula(block.latex);
    if (!math) continue;
    const w = block.cols * cellWidth, h = block.rows * cellHeight;
    const baseScale = cellHeight * 0.5;
    const scale = Math.min(baseScale, (w - 8) / math.width, (h - 8) / math.height);
    if (scale < baseScale * 0.75) continue;
    const x = block.col * cellWidth, y = block.row * cellHeight;
    const mw = math.width * scale, mh = math.height * scale;
    const svg = math.svg.replace(/<svg[^>]*>/, tag => tag
      .replace(/\s(?:width|height|style)="[^"]*"/g, '')
      .replace('>', ` x="${x + (w - mw) / 2}" y="${y + (h - mh) / 2}" width="${mw}" height="${mh}">`));
    shapes.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#1e1e2e"/>`, svg);
    placements.push(block);
  }
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" color="#cdd6f4">${shapes.join('')}</svg>`;
  const rendered = new Resvg(source, { font: { loadSystemFonts: /<text[\s>]/.test(source) } }).render();
  return { pixels: rendered.pixels, width, height, cols, rows, placements };
}
