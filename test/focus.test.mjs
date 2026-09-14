import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('renderer streams changed text, recovers missed focus events and closed panes, and exits when disabled', async () => {
  const directory = await mkdtemp(`${tmpdir()}/herdr-math-focus-`);
  const path = `${directory}/socket`;
  let enabled = true;
  let currentPane = 'first';
  const missingPanes = new Set();
  const missingPaneErrors = new Set();
  let emptyPaneReads = 0;
  let text = '\n$$\nx^2\n$$\n';
  let events;
  const scrollEvents = new Map();
  let scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0 };
  let holdReads = false;
  const heldReads = [];
  const calls = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    let pane;
    let header;
    socket.on('close', () => {
      sockets.delete(socket);
      if (pane) calls.push({ method: 'closed', pane });
    });
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length) {
        if (header) {
          if (pending.length < header.data_length) return;
          const pixels = Buffer.from(pending.subarray(0, header.data_length));
          pending = pending.subarray(header.data_length);
          calls.push({ method: 'frame', pane, header, pixels });
          header = undefined;
          continue;
        }
        const end = pending.indexOf(10);
        if (end < 0) return;
        const message = JSON.parse(pending.subarray(0, end).toString());
        pending = pending.subarray(end + 1);
        if (pane) { header = message; continue; }
        const { id, method, params } = message;
        calls.push({ method, pane: params.pane_id });
        if (method === 'pane.current' && !currentPane) {
          emptyPaneReads++;
          socket.end(JSON.stringify({ id, error: { code: 'pane_not_found', message: 'No current pane' } }) + '\n');
          continue;
        }
        if (method.startsWith('pane.') && missingPanes.has(params.pane_id)) {
          missingPaneErrors.add(params.pane_id);
          socket.end(JSON.stringify({ id, error: { code: 'pane_not_found', message: 'Pane closed' } }) + '\n');
          continue;
        }
        if (method === 'events.subscribe') {
          const filter = params.subscriptions.find(item => item.type === 'pane.scroll_changed');
          if (filter) scrollEvents.set(filter.pane_id, socket);
          else events = socket;
          socket.write(JSON.stringify({ id, result: {} }) + '\n');
        } else if (method === 'pane.graphics.stream') {
          pane = params.pane_id;
          socket.write(JSON.stringify({ id, result: {} }) + '\n');
        } else {
          const result = method === 'plugin.list' ? { plugins: [{ enabled }] }
            : method === 'pane.current' ? { pane: { pane_id: currentPane } }
            : method === 'pane.graphics.info' ? { pane_visible: true, cell_width_px: 9, cell_height_px: 20 }
            : method === 'pane.get' ? { pane: { scroll: { ...scroll } } }
            : method === 'pane.read' ? { read: { text } }
            : {};
          const reply = () => socket.end(JSON.stringify({ id, result }) + '\n');
          if (method === 'pane.read' && holdReads) heldReads.push(reply);
          else reply();
        }
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  const env = { ...process.env, HERDR_SOCKET_PATH: path, HERDR_PANE_ID: 'ignored' };
  delete env.HERDR_PLUGIN_EVENT;
  const worker = spawn(process.execPath, ['src/main.mjs'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  worker.stderr.on('data', data => { stderr += data; });
  const exited = once(worker, 'exit');
  async function waitFor(predicate, description) {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await delay(10);
    }
    assert.fail(`Missing ${description}: ${stderr}`);
  }
  const frames = pane => calls.filter(call => call.method === 'frame' && call.pane === pane);
  try {
    await waitFor(() => frames('first').length === 2, 'initial frame pair');
    const first = frames('first')[0];
    assert.equal(first.header.format, 'rgba');
    assert.equal(first.pixels.length, first.header.image_width * first.header.image_height * 4);
    assert(first.pixels.some(byte => byte !== 0));
    const reads = calls.filter(call => call.method === 'pane.read').length;
    await waitFor(() => calls.filter(call => call.method === 'pane.read').length >= reads + 5, 'stable polling');
    assert.equal(frames('first').length, 2, 'stable text must not retransmit pixels');

    text = '\n$$\ny^3\n$$\n';
    await waitFor(() => frames('first').length === 4, 'changed-text frame pair');
    assert(!frames('first')[2].pixels.equals(first.pixels));

    holdReads = true;
    await waitFor(() => heldReads.length > 0, 'blocked snapshot');
    scroll = { offset_from_bottom: 3, max_offset_from_bottom: 0 };
    scrollEvents.get('first').write(JSON.stringify({ event: 'pane_scroll_changed', data: { scroll } }) + '\n');
    await waitFor(() => frames('first').length === 5, 'immediate scroll placement');
    assert.equal(frames('first')[4].header.placement.viewport_row, 3);
    assert(frames('first')[4].pixels.equals(frames('first')[3].pixels), 'scroll reuses cached pixels');
    assert(heldReads.length > 0, 'scroll placement must precede snapshot completion');
    text = '\n\n\n' + text;
    holdReads = false;
    for (const reply of heldReads.splice(0)) reply();
    await waitFor(() => frames('first').length === 7, 'replacement frame pair after scroll');
    assert.equal(frames('first')[5].header.placement.viewport_row, 0);

    currentPane = 'second';
    const event = JSON.stringify({ event: 'pane_focused', data: { pane_id: currentPane } }) + '\n';
    events.write(event.slice(0, 12));
    events.write(event.slice(12));
    await waitFor(() => frames('second').length === 2, 'focused-pane frame pair');
    const closed = calls.findIndex(call => call.method === 'closed' && call.pane === 'first');
    const rendered = calls.findIndex(call => call.method === 'frame' && call.pane === 'second');
    assert(closed >= 0 && closed < rendered, 'old stream must close before the new pane renders');

    // Losing a focus event must not leave the renderer polling a closed pane.
    missingPanes.add('second');
    await waitFor(() => missingPaneErrors.has('second'), 'pane_not_found response from the closed pane');
    currentPane = 'third';
    await waitFor(() => frames('third').length === 2, 'recovery from closed pane without a focus event');

    // A session can temporarily have no panes, then create one without a focus event.
    missingPanes.add('third');
    currentPane = undefined;
    await waitFor(() => calls.some(call => call.method === 'closed' && call.pane === 'third'), 'closed pane cleanup');
    await waitFor(() => emptyPaneReads >= 2, 'reconciliation while the session has no current pane');
    currentPane = 'fourth';
    await waitFor(() => frames('fourth').length === 2, 'recovery after a period with no panes');

    // Missed focus events also matter when the previous pane still exists.
    currentPane = 'fifth';
    await waitFor(() => frames('fifth').length === 2, 'focus reconciliation for an existing pane');

    enabled = false;
    await waitFor(() => worker.exitCode !== null, 'worker exit after disable');
    assert.equal(worker.exitCode, 0, stderr);
    await waitFor(() => calls.some(call => call.method === 'closed' && call.pane === 'fifth'), 'final stream closure');
  } finally {
    holdReads = false;
    for (const reply of heldReads.splice(0)) reply();
    if (worker.exitCode === null) worker.kill();
    await exited;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
  }
});
