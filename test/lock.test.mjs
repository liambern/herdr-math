import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireLock } from '../src/lock.mjs';

test('lock excludes duplicate workers and recovers after SIGKILL', async t => {
  const directory = await mkdtemp(`${tmpdir()}/herdr-math-lock-`);
  const path = `${directory}/socket`;
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireLock } from './src/lock.mjs'; await acquireLock(process.argv[1]); console.log('ready');`, path],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  assert.equal(await acquireLock(path), null);
  child.kill('SIGKILL');
  await exited;
  const lock = await acquireLock(path);
  assert(lock);
  assert.equal(await acquireLock(path), null);
  await new Promise(resolve => lock.close(resolve));
  await writeFile(path, 'keep me');
  await assert.rejects(acquireLock(path), /owned socket/);
  assert.equal(await readFile(path, 'utf8'), 'keep me');
});
