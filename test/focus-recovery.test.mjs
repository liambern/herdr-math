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

async function renderer(t, pane) {
  const directory = await mkdtemp(`${tmpdir()}/herdr-math-recovery-`);
  const path = `${directory}/socket`;
  const state = { pane, holdCurrent: false, currentReads: 0, replies: [], calls: [] };
  const sockets = new Set();
  let events;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    let streamPane;
    let header;
    socket.on('close', () => {
      sockets.delete(socket);
      if (streamPane) state.calls.push(`closed:${streamPane}`);
    });
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length) {
        if (header) {
          if (pending.length < header.data_length) return;
          pending = pending.subarray(header.data_length);
          state.calls.push(`frame:${streamPane}`);
          header = undefined;
          continue;
        }
        const end = pending.indexOf(10);
        if (end < 0) return;
        const message = JSON.parse(pending.subarray(0, end).toString());
        pending = pending.subarray(end + 1);
        if (streamPane) { header = message; continue; }
        const { id, method, params } = message;
        if (method === 'events.subscribe') {
          if (params.subscriptions.some(item => item.type === 'pane.focused')) events = socket;
          socket.write(JSON.stringify({ id, result: {} }) + '\n');
        } else if (method === 'pane.graphics.stream') {
          streamPane = params.pane_id;
          state.calls.push(`opened:${streamPane}`);
          socket.write(JSON.stringify({ id, result: {} }) + '\n');
        } else {
          const result = method === 'pane.current' ? { pane: { pane_id: state.pane } }
            : method === 'plugin.list' ? { plugins: [{ enabled: true }] }
            : method === 'pane.graphics.info' ? { pane_visible: true, cell_width_px: 9, cell_height_px: 20 }
            : method === 'pane.read' ? { read: { text: '\n$$\nx^2\n$$\n' } }
            : method === 'pane.layout' ? { layout: { zoomed: false, panes: [{ pane_id: params.pane_id, rect: { width: 100 } }] } }
            : method === 'pane.get' ? { pane: { scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0 } } }
            : {};
          const response = method === 'pane.current' && !state.pane
            ? { id, error: { code: 'pane_not_found', message: 'No focused pane.' } }
            : { id, result };
          const reply = () => socket.end(JSON.stringify(response) + '\n');
          if (method === 'pane.current') state.currentReads++;
          if (method === 'pane.current' && state.holdCurrent) state.replies.push(reply);
          else reply();
        }
      }
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
  state.frames = pane => state.calls.filter(call => call === `frame:${pane}`).length;
  state.focusEvent = pane => {
    state.pane = pane;
    events.write(JSON.stringify({ event: 'pane_focused', data: { pane_id: pane } }) + '\n');
  };
  return state;
}

test('renderer recovers when navigation changes the current pane without a focus event', async t => {
  const state = await renderer(t, 'first');
  await state.waitFor(() => state.frames('first') === 2, 'initial frame pair');
  state.pane = 'second';
  await state.waitFor(() => state.frames('second') === 2, 'frames after silent tab switch');
  assert(state.calls.indexOf('closed:first') < state.calls.indexOf('frame:second'));
  const reads = state.currentReads;
  await state.waitFor(() => state.currentReads >= reads + 2, 'unchanged focus checks');
  assert.equal(state.frames('second'), 2, 'unchanged focus must not retransmit pixels');
  assert.equal(state.calls.filter(call => call === 'opened:second').length, 1);

  state.pane = undefined;
  await state.waitFor(() => state.calls.includes('closed:second'), 'stream closure with no focused pane');
  state.pane = 'third';
  await state.waitFor(() => state.frames('third') === 2, 'frames after a pane becomes available');
});

test('renderer recovers when started before a current pane is available', async t => {
  const state = await renderer(t);
  await state.waitFor(() => state.currentReads >= 1, 'initial empty focus read');
  state.pane = 'first';
  await state.waitFor(() => state.frames('first') === 2, 'first pane without a focus event');
});

test('a delayed current-pane response cannot undo a newer focus event', async t => {
  const state = await renderer(t, 'first');
  await state.waitFor(() => state.frames('first') === 2, 'initial frame pair');
  state.holdCurrent = true;
  await state.waitFor(() => state.replies.length === 1, 'held focus snapshot');
  state.focusEvent('second');
  await state.waitFor(() => state.frames('second') === 2, 'event-driven frames before snapshot completion');
  state.replies.shift()();
  await state.waitFor(() => state.replies.length === 1, 'next focus check after stale response');
  assert.equal(state.calls.filter(call => call === 'opened:first').length, 1, 'stale response must not restore old pane');
  assert.equal(state.frames('second'), 2);
});


test('shutdown cancels a stalled current-pane request', async t => {
  const state = await renderer(t, 'first');
  await state.waitFor(() => state.frames('first') === 2, 'initial frames');
  state.holdCurrent = true;
  await state.waitFor(() => state.replies.length === 1, 'stalled focus request');
  const started = performance.now();
  const [code] = await state.stop();
  assert.equal(code, 0);
  assert(performance.now() - started < 1500, 'shutdown must cancel the request, not wait for its deadline');
});


test('toggle hides overlays across focus changes and restores the current pane', async t => {
  const state = await renderer(t, 'first');
  await state.waitFor(() => state.frames('first') === 2, 'initial frames');
  assert.deepEqual(await state.toggle(), { visible: false });
  await state.waitFor(() => state.calls.includes('closed:first'), 'hidden overlay stream');
  state.focusEvent('second');
  const reads = state.currentReads;
  await state.waitFor(() => state.currentReads > reads, 'focus reconciliation while hidden');
  assert.equal(state.frames('second'), 0);
  assert.deepEqual(await state.toggle(), { visible: true });
  await state.waitFor(() => state.frames('second') === 2, 'restored overlays in current pane');
});
