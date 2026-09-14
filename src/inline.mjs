import stringWidth from 'string-width';

const escaped = (text, index) => {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
};
const fenceMark = line => /^\s*(?:[•●⏺]\s+)?(`{3,}|~{3,})/.exec(line)?.[1];

export function findInline(text, displayBlocks = []) {
  const excluded = new Set(displayBlocks.flatMap(block => Array.from({ length: block.rows }, (_, i) => block.row + i)));
  const spans = [];
  let fence, displayEnd;
  for (const [row, line] of text.split('\n').entries()) {
    const mark = fenceMark(line);
    if (mark) {
      if (!fence) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    // Incomplete display blocks must not turn their contents into inline math.
    const display = /^\s*(?:[•●⏺]\s+)?(\$\$|\\\[|\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\})/.exec(line);
    if (displayEnd) {
      if (line.includes(displayEnd)) displayEnd = undefined;
      continue;
    }
    if (display) {
      const end = display[1] === '$$' ? '$$' : display[1] === '\\[' ? '\\]' : `\\end{${display[2]}}`;
      if (!line.slice(display[0].length).includes(end)) displayEnd = end;
      continue;
    }
    if (excluded.has(row) || line.includes('\t')) continue;
    for (let i = 0; i < line.length;) {
      if (line[i] === '`' && !escaped(line, i)) {
        let count = 1;
        while (line[i + count] === '`') count++;
        let end = i + count;
        for (; end < line.length; end++) {
          if (line[end] !== '`') continue;
          let run = 1;
          while (line[end + run] === '`') run++;
          if (run === count) break;
          end += run - 1;
        }
        i = end + count;
        continue;
      }
      const paren = line.startsWith('\\(', i) && !escaped(line, i);
      const dollar = line[i] === '$' && !escaped(line, i);
      if (!paren && !dollar) { i++; continue; }
      if (dollar && (line[i - 1] === '$' || line[i + 1] === '$')) { i++; continue; }
      const openLength = paren ? 2 : 1;
      const close = paren ? '\\)' : '$';
      let end = i + openLength;
      while (end < line.length && !(line.startsWith(close, end) && !escaped(line, end))) end++;
      if (end === line.length) { i += openLength; continue; }
      const latex = line.slice(i + openLength, end);
      if (!latex.trim() || (dollar && (/^\s|\s$/.test(latex) || /\d/.test(line[end + 1] ?? '') || line[end + 1] === '$'))) {
        i += openLength;
        continue;
      }
      const last = end + close.length;
      spans.push({ latex, inline: true, row, rows: 1, col: stringWidth(line.slice(0, i)), cols: stringWidth(line.slice(i, last)) });
      i = last;
    }
  }
  return spans;
}
