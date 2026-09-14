import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('renderer follows focus, clears the old pane, and survives a closed pane', async () => {
  const directory = await mkdtemp(`${tmpdir()}/herdr-math-focus-`);
  const path = `${directory}/socket`;
  let focused = 'first';
  let closed = false;
  const calls = [];
  const server = net.createServer(socket => {
    socket.once('data', data => {
      const { id, method, params } = JSON.parse(data);
      calls.push({ method, pane: params.pane_id });
      if (closed && params.pane_id === 'second') {
        socket.end(JSON.stringify({ id, error: { code: 'not_found', message: 'Pane closed' } }) + '\n');
        return;
      }
      const result = method === 'plugin.list' ? { plugins: [{ enabled: true }] }
        : method === 'pane.current' ? { pane: { pane_id: focused } }
        : method === 'pane.graphics.info' ? { pane_visible: true, cell_width_px: 9, cell_height_px: 20 }
        : method === 'pane.read' ? { read: { text: '\n$$\nx^2\n$$\n' } }
        : {};
      socket.end(JSON.stringify({ id, result }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  const worker = spawn(process.execPath, ['src/main.mjs'], {
    env: { ...process.env, HERDR_SOCKET_PATH: path, HERDR_PANE_ID: 'ignored' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  worker.stderr.on('data', data => { stderr += data; });
  const exited = once(worker, 'exit');
  async function waitFor(method, pane) {
    for (let i = 0; i < 100; i++) {
      if (calls.some(call => call.method === method && call.pane === pane)) return;
      await delay(50);
    }
    assert.fail(`Missing ${method} for ${pane}: ${stderr}`);
  }
  try {
    await waitFor('pane.graphics.set', 'first');
    focused = 'second';
    await waitFor('pane.graphics.set', 'second');
    assert(calls.findIndex(c => c.method === 'pane.graphics.clear' && c.pane === 'first') < calls.findIndex(c => c.method === 'pane.graphics.set' && c.pane === 'second'));
    closed = true;
    focused = 'third';
    await waitFor('pane.graphics.set', 'third');
  } finally {
    worker.kill();
    const [code] = await exited;
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
    assert.equal(code, 0, stderr);
  }
  assert(calls.some(c => c.method === 'pane.graphics.clear' && c.pane === 'third'));
});
