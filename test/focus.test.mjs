import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fakePanes } from './panes.mjs';

test('renderer writes changed text to the pane terminal, recovers missed focus events and closed panes, and exits when disabled', async () => {
  const directory = await mkdtemp(`${tmpdir()}/herdr-math-focus-`);
  const path = `${directory}/socket`;
  const panes = fakePanes();
  let enabled = true;
  let currentPane = 'first';
  const missingPanes = new Set();
  const missingPaneErrors = new Set();
  let emptyPaneReads = 0;
  let text = '\n$$\nx^2\n$$\n';
  let events;
  const scrollEvents = new Map();
  let scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0 };
  const calls = [];
  const sockets = new Set();
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
      calls.push({ method, pane: params.pane_id });
      if (method === 'pane.current' && !currentPane) {
        emptyPaneReads++;
        socket.end(JSON.stringify({ id, error: { code: 'pane_not_found', message: 'No current pane' } }) + '\n');
        return;
      }
      if (method.startsWith('pane.') && missingPanes.has(params.pane_id)) {
        missingPaneErrors.add(params.pane_id);
        socket.end(JSON.stringify({ id, error: { code: 'pane_not_found', message: 'Pane closed' } }) + '\n');
        return;
      }
      if (method === 'events.subscribe') {
        const filter = params.subscriptions.find(item => item.type === 'pane.scroll_changed');
        if (filter) scrollEvents.set(filter.pane_id, socket);
        else events = socket;
        socket.write(JSON.stringify({ id, result: {} }) + '\n');
        return;
      }
      const result = method === 'plugin.list' ? { plugins: [{ enabled }] }
        : method === 'pane.current' ? { pane: { pane_id: currentPane } }
        : method === 'pane.process_info' ? { process_info: { shell_pid: await panes.pid(params.pane_id) } }
        : method === 'pane.get' ? { pane: { scroll: { ...scroll } } }
        : method === 'pane.read' ? { read: { text } }
        : {};
      socket.end(JSON.stringify({ id, result }) + '\n');
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
    for (let i = 0; i < 500; i++) {
      if (predicate()) return;
      await delay(10);
    }
    assert.fail(`Missing ${description}: ${stderr}`);
  }
  const reads = () => calls.filter(call => call.method === 'pane.read').length;
  try {
    await waitFor(() => panes.frames('first') === 1, 'initial frame');
    assert.match(panes.heads('first')[0], /f=100,.*C=1,q=2,m=\d;iVBORw0KGgo/);
    let before = reads();
    await waitFor(() => reads() >= before + 2, 'stable polling');
    assert.equal(panes.frames('first'), 1, 'stable text must not retransmit pixels');

    text = '\n$$\ny^3\n$$\n';
    await waitFor(() => panes.frames('first') === 2, 'changed-text frame');

    // While the user scrolls back, the existing image scrolls with the text; nothing is redrawn.
    scroll = { offset_from_bottom: 3, max_offset_from_bottom: 0 };
    scrollEvents.get('first').write(JSON.stringify({ event: 'pane_scroll_changed', data: { scroll } }) + '\n');
    text = '\n\n\n' + text;
    before = reads();
    await waitFor(() => reads() >= before + 3, 'polling while scrolled back');
    assert.equal(panes.frames('first'), 2, 'no frame while scrolled back');
    scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0 };
    scrollEvents.get('first').write(JSON.stringify({ event: 'pane_scroll_changed', data: { scroll } }) + '\n');
    await waitFor(() => panes.frames('first') === 3, 'fresh frame back at the bottom');

    currentPane = 'second';
    const event = JSON.stringify({ event: 'pane_focused', data: { pane_id: currentPane } }) + '\n';
    events.write(event.slice(0, 12));
    events.write(event.slice(12));
    await waitFor(() => panes.frames('second') === 1, 'focused-pane frame');
    const cleared = panes.index('clear', 'first');
    assert(cleared >= 0 && cleared < panes.index('frame', 'second'), 'old image must be removed before the new pane renders');

    // Losing a focus event must not leave the renderer polling a closed pane.
    missingPanes.add('second');
    await waitFor(() => missingPaneErrors.has('second'), 'pane_not_found response from the closed pane');
    currentPane = 'third';
    await waitFor(() => panes.frames('third') === 1, 'recovery from closed pane without a focus event');

    // A session can temporarily have no panes, then create one without a focus event.
    missingPanes.add('third');
    currentPane = undefined;
    await waitFor(() => panes.clears('third') >= 1, 'closed pane cleanup');
    await waitFor(() => emptyPaneReads >= 2, 'reconciliation while the session has no current pane');
    currentPane = 'fourth';
    await waitFor(() => panes.frames('fourth') === 1, 'recovery after a period with no panes');

    // Missed focus events also matter when the previous pane still exists.
    currentPane = 'fifth';
    await waitFor(() => panes.frames('fifth') === 1, 'focus reconciliation for an existing pane');
    assert(panes.clears('fourth') >= 1, 'previous pane image removed');

    enabled = false;
    await waitFor(() => worker.exitCode !== null, 'worker exit after disable');
    assert.equal(worker.exitCode, 0, stderr);
    await waitFor(() => panes.clears('fifth') >= 1, 'final image removal');
  } finally {
    if (worker.exitCode === null) worker.kill();
    await exited;
    panes.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
  }
});
