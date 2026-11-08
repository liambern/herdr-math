import { Cache } from './cache.mjs';
import { RenderSchedule } from './schedule.mjs';
import { acquireLock } from './lock.mjs';
import { controlPath, handleControl } from './control.mjs';
import { request, subscribe, openPaneGraphics } from './herdr.mjs';

const path = process.env.HERDR_SOCKET_PATH;
if (!path) throw new Error('Run the Herdr Math action inside Herdr.');
const control = await acquireLock(controlPath(path));
if (control && process.env.HERDR_PLUGIN_EVENT) {
  await new Promise(resolve => control.close(resolve));
  await request(path, 'plugin.action.invoke', { action_id: 'herdr-math.start' });
} else if (control) {
  let stopped = false;
  const shutdown = new AbortController();
  const options = { signal: shutdown.signal };
  const stop = () => { stopped = true; shutdown.abort(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let focused;
  let desiredPane;
  let paused = false;
  let focusRevision = 0;
  let generation = 0;
  let revision = 0;
  let activeGraphics;
  let paneController;
  let subscription;
  let failure;
  const tasks = new Set();
  const frames = new Cache(32 * 1024 * 1024, 8);
  let schedule;
  try {
    const { renderFrame } = await import('./math.mjs');
    async function renderPane(pane, mine, signal) {
      const paneOptions = { signal };
      const work = new RenderSchedule(signal);
      schedule = work;
      let graphics;
      let scrollEvents;
      let size;
      let sizeRevision;
      let previous;
      try {
        while (!stopped && generation === mine) {
          await work.wait();
          if (stopped || generation !== mine) break;
          try {
            // Images are part of the pane's content and scroll with its text, so scrolling only
            // needs a fresh snapshot once the pane is back at the bottom.
            scrollEvents ??= await subscribe(path, [{ type: 'pane.scroll_changed', pane_id: pane }], () => work.notify(), paneOptions);
            if (!graphics) {
              graphics = await openPaneGraphics(path, pane, paneOptions);
              if (generation === mine) activeGraphics = graphics;
            }
            const readingRevision = revision;
            const [info, result] = await Promise.all([
              request(path, 'pane.get', { pane_id: pane }, paneOptions),
              request(path, 'pane.read', { pane_id: pane, source: 'visible', lines: 10000 }, paneOptions),
            ]);
            if (scrollEvents.destroyed) throw new Error('Herdr pane connection closed.');
            if (stopped || generation !== mine) break;
            if (readingRevision !== revision) { work.notify(); continue; }
            if (info.pane.scroll.offset_from_bottom !== 0) continue;
            if (sizeRevision !== readingRevision) {
              size = graphics.size();
              sizeRevision = readingRevision;
            }
            const text = result.read.text;
            const key = JSON.stringify([text, size.cellWidth, size.cellHeight, size.cols]);
            if (key !== previous) {
              let frame = frames.get(key);
              if (!frame) {
                frame = renderFrame(text, size.cellWidth, size.cellHeight, size.cols);
                frames.set(key, frame, frame.pixels.length);
              }
              graphics.send(frame);
              previous = key;
            }
          } catch (error) {
            if (stopped || generation !== mine) break;
            // The text cannot be rendered at this size: show none until the text or layout changes.
            if (error instanceof RangeError) {
              if (previous !== undefined) graphics?.send({ placements: [] });
              previous = undefined;
              continue;
            }
            if (!['not_found', 'pane_not_found', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EIO'].includes(error.code)) throw error;
            graphics?.close();
            graphics = undefined;
            scrollEvents?.destroy();
            scrollEvents = undefined;
            sizeRevision = undefined;
            previous = undefined;
          }
        }
      } finally {
        scrollEvents?.destroy();
        graphics?.close();
      }
    }
    function focus(pane) {
      desiredPane = pane;
      if (paused) pane = undefined;
      if (pane === focused) return;
      focused = pane;
      const mine = ++generation;
      paneController?.abort();
      paneController = new AbortController();
      // Remove the old pane's image before another pane renders.
      activeGraphics?.close();
      activeGraphics = undefined;
      if (!pane) return;
      const task = renderPane(pane, mine, AbortSignal.any([shutdown.signal, paneController.signal])).catch(error => {
        if (generation !== mine || stopped) return;
        failure = error;
        stop();
      }).finally(() => tasks.delete(task));
      tasks.add(task);
    }
    control.removeAllListeners('connection');
    control.on('connection', socket => handleControl(socket, () => {
      paused = !paused;
      focus(desiredPane);
      return !paused;
    }));
    subscription = await subscribe(path, [{ type: 'pane.focused' }, { type: 'layout.updated' }], event => {
      if (event.event === 'pane_focused') {
        focusRevision++;
        focus(event.data.pane_id);
      }
      else { revision++; schedule?.notify(); }
    }, options);
    subscription.on('close', stop);
    while (!stopped) {
      const { plugins } = await request(path, 'plugin.list', { plugin_id: 'herdr-math' }, options);
      if (!plugins.some(plugin => plugin.enabled)) break;
      // Herdr shell navigation can change the current pane without a focus event.
      // Reconcile here as well as following events, including startup with no pane.
      const readingFocus = focusRevision;
      const current = await request(path, 'pane.current', {}, options).catch(error => {
        if (!['not_found', 'pane_not_found'].includes(error.code)) throw error;
        return {};
      });
      // An event received during the request is newer than this snapshot.
      if (!stopped && readingFocus === focusRevision) focus(current.pane?.pane_id);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (failure) throw failure;
  } catch (error) {
    if (!stopped || error.code !== 'ABORT_ERR') throw error;
    if (failure) throw failure;
  } finally {
    stop();
    subscription?.destroy();
    activeGraphics?.close();
    await Promise.all(tasks);
    control.close();
  }
}
