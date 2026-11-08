import { request } from '../src/herdr.mjs';
import { controlPath } from '../src/control.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fakePanes } from './panes.mjs';

async function renderer(t, pane) {
  const directory = await mkdtemp(`${tmpdir()}/herdr-math-recovery-`);
  const path = `${directory}/socket`;
  const panes = fakePanes();
  const state = { pane, holdCurrent: false, currentReads: 0, replies: [], opened: [] };
  const sockets = new Set();
  let events;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let pending = '';
    socket.on('data', async data => {
      pending += data;
      const end = pending.indexOf('\n');
      if (end < 0) return;
      const { id, method, params } = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      if (method === 'events.subscribe') {
        if (params.subscriptions.some(item => item.type === 'pane.focused')) events = socket;
        socket.write(JSON.stringify({ id, result: {} }) + '\n');
        return;
      }
      if (method === 'pane.process_info') state.opened.push(params.pane_id);
      const result = method === 'pane.current' ? { pane: { pane_id: state.pane } }
        : method === 'plugin.list' ? { plugins: [{ enabled: true }] }
        : method === 'pane.process_info' ? { process_info: { shell_pid: await panes.pid(params.pane_id) } }
        : method === 'pane.read' ? { read: { text: '\n$$\nx^2\n$$\n' } }
        : method === 'pane.get' ? { pane: { scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0 } } }
        : {};
      const response = method === 'pane.current' && !state.pane
        ? { id, error: { code: 'pane_not_found', message: 'No focused pane.' } }
        : { id, result };
      const reply = () => socket.end(JSON.stringify(response) + '\n');
      if (method === 'pane.current') state.currentReads++;
      if (method === 'pane.current' && state.holdCurrent) state.replies.push(reply);
      else reply();
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  const env = { ...process.env, HERDR_SOCKET_PATH: path };
  delete env.HERDR_PLUGIN_EVENT;
  const worker = spawn(process.execPath, ['src/main.mjs'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(worker, 'exit');
  let stderr = '';
  worker.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    worker.kill();
    state.holdCurrent = false;
    for (const reply of state.replies.splice(0)) reply();
    await exited;
    panes.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
  });
  state.waitFor = async (predicate, description) => {
    for (let i = 0; i < 500; i++) {
      if (predicate()) return;
      assert.equal(worker.exitCode, null, stderr);
      await delay(10);
    }
    assert.fail(`Missing ${description}: ${stderr}`);
  };
  state.toggle = () => request(controlPath(path), 'toggle', {});
  state.stop = () => { worker.kill(); return exited; };
  state.frames = pane => panes.frames(pane);
  state.cleared = pane => panes.clears(pane) > 0;
  state.clearedBeforeFrame = (old, pane) => panes.index('clear', old) >= 0 && panes.index('clear', old) < panes.index('frame', pane);
  state.focusEvent = pane => {
    state.pane = pane;
    events.write(JSON.stringify({ event: 'pane_focused', data: { pane_id: pane } }) + '\n');
  };
  return state;
}

test('renderer recovers when navigation changes the current pane without a focus event', async t => {
  const state = await renderer(t, 'first');
  await state.waitFor(() => state.frames('first') === 1, 'initial frame');
  state.pane = 'second';
  await state.waitFor(() => state.frames('second') === 1, 'frame after silent tab switch');
  assert(state.clearedBeforeFrame('first', 'second'), 'old image removed before the new pane renders');
  const reads = state.currentReads;
  await state.waitFor(() => state.currentReads >= reads + 2, 'unchanged focus checks');
  assert.equal(state.frames('second'), 1, 'unchanged focus must not retransmit pixels');
  assert.equal(state.opened.filter(pane => pane === 'second').length, 1, 'terminal opened once');

  state.pane = undefined;
  await state.waitFor(() => state.cleared('second'), 'image removal with no focused pane');
  state.pane = 'third';
  await state.waitFor(() => state.frames('third') === 1, 'frames after a pane becomes available');
});

test('renderer recovers when started before a current pane is available', async t => {
  const state = await renderer(t);
  await state.waitFor(() => state.currentReads >= 1, 'initial empty focus read');
  state.pane = 'first';
  await state.waitFor(() => state.frames('first') === 1, 'first pane without a focus event');
});

test('a delayed current-pane response cannot undo a newer focus event', async t => {
  const state = await renderer(t, 'first');
  await state.waitFor(() => state.frames('first') === 1, 'initial frame');
  state.holdCurrent = true;
  await state.waitFor(() => state.replies.length === 1, 'held focus snapshot');
  state.focusEvent('second');
  await state.waitFor(() => state.frames('second') === 1, 'event-driven frames before snapshot completion');
  state.replies.shift()();
  await state.waitFor(() => state.replies.length === 1, 'next focus check after stale response');
  assert.equal(state.opened.filter(pane => pane === 'first').length, 1, 'stale response must not restore old pane');
  assert.equal(state.frames('second'), 1);
});


test('shutdown cancels a stalled current-pane request', async t => {
  const state = await renderer(t, 'first');
  await state.waitFor(() => state.frames('first') === 1, 'initial frames');
  state.holdCurrent = true;
  await state.waitFor(() => state.replies.length === 1, 'stalled focus request');
  const started = performance.now();
  const [code] = await state.stop();
  assert.equal(code, 0);
  assert(performance.now() - started < 1500, 'shutdown must cancel the request, not wait for its deadline');
});


test('toggle hides overlays across focus changes and restores the current pane', async t => {
  const state = await renderer(t, 'first');
  await state.waitFor(() => state.frames('first') === 1, 'initial frames');
  assert.deepEqual(await state.toggle(), { visible: false });
  await state.waitFor(() => state.cleared('first'), 'hidden overlay removed');
  state.focusEvent('second');
  const reads = state.currentReads;
  await state.waitFor(() => state.currentReads > reads, 'focus reconciliation while hidden');
  assert.equal(state.frames('second'), 0);
  assert.deepEqual(await state.toggle(), { visible: true });
  await state.waitFor(() => state.frames('second') === 1, 'restored overlays in current pane');
});
