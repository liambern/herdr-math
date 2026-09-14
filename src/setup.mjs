import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';

const binary = process.env.HERDR_BIN_PATH || 'herdr';
const defaults = execFileSync(binary, ['--default-config'], { encoding: 'utf8' });
let table;
let found = false;
for (const line of defaults.split('\n')) {
  const header = line.match(/^\[([^\]]+)\]/);
  if (header) table = header[1];
  if (/^\s*#?\s*kitty_graphics\s*=/.test(line)) { found = true; break; }
}
if (!found || !table) throw new Error('Herdr does not expose a kitty_graphics setting.');
const path = process.env.HERDR_CONFIG_PATH || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdr', 'config.toml');
const source = await readFile(path, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const expected = parse(source);
if (expected[table]?.kitty_graphics !== true) {
  expected[table] ??= {};
  expected[table].kitty_graphics = true;
  const lines = source.split('\n');
  let start = lines.findIndex(line => line.split('#', 1)[0].trim() === `[${table}]`);
  if (start < 0) {
    lines.push('', `[${table}]`, 'kitty_graphics = true', '');
  } else {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    const key = lines.findIndex((line, index) => index > start && index < end && /^\s*kitty_graphics\s*=/.test(line));
    if (key < 0) lines.splice(start + 1, 0, 'kitty_graphics = true');
    else lines[key] = lines[key].replace(/=\s*false\b/, '= true');
  }
  const updated = lines.join('\n');
  if (!isDeepStrictEqual(parse(updated), expected)) throw new Error(`Cannot update ${path} without changing other settings. Set [${table}] kitty_graphics = true.`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, updated);
  console.log(`Enabled [${table}] kitty_graphics in ${path}. Existing sessions may need a compatible terminal reattach or restart.`);
}
