import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

test('installation enables graphics, preserves settings and comments, and is idempotent', async () => {
  const directory = await mkdtemp(`${tmpdir()}/herdr-math-setup-`);
  const config = `${directory}/config.toml`;
  const binary = `${directory}/herdr`;
  await writeFile(binary, '#!/bin/sh\nprintf "[terminal]\\n# kitty_graphics = false\\n"\n', { mode: 0o755 });
  const env = { ...process.env, HERDR_BIN_PATH: binary, HERDR_CONFIG_PATH: config };
  const run = () => execFileSync(process.execPath, ['src/setup.mjs'], { env, stdio: 'pipe' });
  try {
    run();
    assert.match(await readFile(config, 'utf8'), /\[terminal\]\nkitty_graphics = true/);
    const before = '# My theme\n[ui]\ntheme = "dark"\n\n[terminal] # terminal settings\nkitty_graphics = false # graphics\n';
    await writeFile(config, before);
    run();
    const after = await readFile(config, 'utf8');
    assert.equal(after, before.replace('false # graphics', 'true # graphics'));
    run();
    assert.equal(await readFile(config, 'utf8'), after);
    await writeFile(config, 'terminal = { kitty_graphics = false }\n');
    assert.throws(run);
    assert.equal(await readFile(config, 'utf8'), 'terminal = { kitty_graphics = false }\n');
  } finally {
    await rm(directory, { recursive: true });
  }
});
