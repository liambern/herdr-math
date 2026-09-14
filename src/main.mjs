import net from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { request, subscribe, openGraphicsStream } from './herdr.mjs';

const path = process.env.HERDR_SOCKET_PATH;
if (!path) throw new Error('Run the Herdr Math action inside Herdr.');
const key = createHash('sha256').update(path).digest('hex').slice(0, 20);
const controlPath = `${tmpdir()}/herdr-math-${key}.sock`;

const running = await new Promise((resolve, reject) => {
  const socket = net.createConnection(controlPath);
  socket.on('connect', () => { socket.end(); resolve(true); });
  socket.on('error', error => error.code === 'ENOENT' ? resolve(false) : reject(error));
});
if (!running && process.env.HERDR_PLUGIN_EVENT) {
  await request(path, 'plugin.action.invoke', { action_id: 'herdr-math.start' });
} else if (!running) {
  let stopped = false;
  const control = net.createServer(socket => socket.end());
  const acquired = await new Promise((resolve, reject) => {
    control.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    control.listen(controlPath, () => resolve(true));
  });
  if (!acquired) process.exit(0);
  const stop = () => { stopped = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let focused;
  let focusRevision = 0;
  let generation = 0;
  let revision = 0;
  let activeStream;
  let subscription;
  let failure;
  const tasks = new Set();
  const frames = new Map();
  try {
    const { renderFrame } = await import('./math.mjs');
    async function renderPane(pane, mine) {
      let stream;
      let previous;
      let scrollEvents;
      let scrollRevision = 0;
      let lastFrame;
      let anchor;
      try {
        const scrollOpening = subscribe(path, [{ type: 'pane.scroll_changed', pane_id: pane }], event => {
          const scroll = event.data.scroll;
          scrollRevision++;
          if (stream && lastFrame && anchor !== undefined && generation === mine && !stopped) {
            stream.send(lastFrame, scroll.offset_from_bottom - scroll.max_offset_from_bottom - anchor)
              .catch(error => { if (generation === mine && !stopped) { failure = error; stop(); } });
          }
        });
        while (!stopped && generation === mine) {
          try {
            const readingRevision = revision;
            const readingScroll = scrollRevision;
            const results = await Promise.allSettled([
              request(path, 'pane.graphics.info', { pane_id: pane }),
              request(path, 'pane.read', { pane_id: pane, source: 'visible', lines: 10000 }),
              stream || openGraphicsStream(path, pane),
              request(path, 'pane.get', { pane_id: pane }),
              scrollEvents || scrollOpening,
            ]);
            if (results[2].status === 'fulfilled') stream = results[2].value;
            if (results[4].status === 'fulfilled') scrollEvents = results[4].value;
            if (stopped || generation !== mine) break;
            if (readingScroll !== scrollRevision) continue;
            const error = results.find(result => result.status === 'rejected');
            if (error) throw error.reason;
            activeStream = stream;
            const [geometry, result, , info] = results.map(result => result.value);
            if (geometry.pane_visible && geometry.cell_width_px && geometry.cell_height_px) {
              const text = result.read.text;
              const key = JSON.stringify([text, geometry.cell_width_px, geometry.cell_height_px]);
              const signature = JSON.stringify([key, readingRevision, readingScroll]);
              if (signature !== previous) {
                let frame = frames.get(key);
                if (!frame) {
                  frame = renderFrame(text, geometry.cell_width_px, geometry.cell_height_px);
                  frames.set(key, frame);
                  if (frames.size > 8) frames.delete(frames.keys().next().value);
                }
                lastFrame = frame;
                anchor = info.pane.scroll.offset_from_bottom - info.pane.scroll.max_offset_from_bottom;
                await stream.send(frame, 0);
                await new Promise(resolve => setTimeout(resolve, 20));
                if (!stopped && generation === mine && readingScroll === scrollRevision) await stream.send(frame, 0);
                previous = signature;
              }
            } else previous = undefined;
          } catch (error) {
            if (!['not_found', 'pane_not_found', 'cell_size_unavailable', 'feature_disabled'].includes(error.code)) throw error;
            stream?.close();
            stream = undefined;
            previous = undefined;
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      } finally {
        scrollEvents?.destroy();
        stream?.close();
      }
    }
    function focus(pane) {
      if (pane === focused) return;
      focused = pane;
      const mine = ++generation;
      activeStream?.close();
      activeStream = undefined;
      if (!pane) return;
      const task = renderPane(pane, mine).catch(error => {
        if (generation !== mine || stopped) return;
        failure = error;
        stopped = true;
      }).finally(() => tasks.delete(task));
      tasks.add(task);
    }
    subscription = await subscribe(path, [{ type: 'pane.focused' }, { type: 'layout.updated' }], event => {
      if (event.event === 'pane_focused') {
        focusRevision++;
        focus(event.data.pane_id);
      }
      else revision++;
    });
    subscription.on('close', stop);
    while (!stopped) {
      const { plugins } = await request(path, 'plugin.list', { plugin_id: 'herdr-math' });
      if (!plugins.some(plugin => plugin.enabled)) break;
      // Herdr shell navigation can change the current pane without a focus event.
      // Reconcile here as well as following events, including startup with no pane.
      const readingFocus = focusRevision;
      const current = await request(path, 'pane.current', {}).catch(error => {
        if (!['not_found', 'pane_not_found'].includes(error.code)) throw error;
        return {};
      });
      // An event received during the request is newer than this snapshot.
      if (!stopped && readingFocus === focusRevision) focus(current.pane?.pane_id);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (failure) throw failure;
  } finally {
    stopped = true;
    subscription?.destroy();
    activeStream?.close();
    await Promise.all(tasks);
    control.close();
  }
}
