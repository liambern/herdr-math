import { Cache } from './cache.mjs';
import { RenderSchedule } from './schedule.mjs';
import { acquireLock } from './lock.mjs';
import { controlPath, handleControl } from './control.mjs';
import { request, subscribe, openGraphicsStream } from './herdr.mjs';

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
  let activeStream;
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
      let stream;
      let previous;
      let scrollEvents;
      let scrollOpening;
      let scrollRevision = 0;
      let lastFrame;
      let anchor;
      let scrollTimer;
      let scrollingWrite = false;
      let pendingScroll;
      const flushScroll = async () => {
        scrollTimer = undefined;
        if (scrollingWrite || !pendingScroll || stopped || generation !== mine) return;
        const next = pendingScroll;
        pendingScroll = undefined;
        scrollingWrite = true;
        try { await next.stream.send(next.frame, next.row); }
        catch (error) { if (generation === mine && !stopped) { failure = error; stop(); } }
        finally {
          scrollingWrite = false;
          if (pendingScroll && !stopped && generation === mine) scrollTimer = setTimeout(flushScroll, 0);
        }
      };
      try {
        const openScroll = () => subscribe(path, [{ type: 'pane.scroll_changed', pane_id: pane }], event => {
          const scroll = event.data.scroll;
          scrollRevision++;
          work.notify();
          if (stream && lastFrame && anchor !== undefined && generation === mine && !stopped) {
            pendingScroll = { stream, frame: lastFrame,
              row: scroll.offset_from_bottom - scroll.max_offset_from_bottom - anchor };
            if (!scrollTimer && !scrollingWrite) scrollTimer = setTimeout(flushScroll, 0);
          }
        }, paneOptions);
        while (!stopped && generation === mine) {
          await work.wait();
          if (stopped || generation !== mine) break;
          try {
            scrollOpening ??= openScroll();
            const readingRevision = revision;
            const readingScroll = scrollRevision;
            const results = await Promise.allSettled([
              request(path, 'pane.graphics.info', { pane_id: pane }, paneOptions),
              request(path, 'pane.read', { pane_id: pane, source: 'visible', lines: 10000 }, paneOptions),
              stream || openGraphicsStream(path, pane, paneOptions),
              request(path, 'pane.get', { pane_id: pane }, paneOptions),
              scrollEvents || scrollOpening,
              request(path, 'pane.layout', { pane_id: pane }, paneOptions),
            ]);
            if (results[2].status === 'fulfilled') stream = results[2].value;
            if (results[4].status === 'fulfilled') scrollEvents = results[4].value;
            if (scrollEvents?.destroyed || stream?.closed) throw new Error('Herdr pane connection closed.');
            if (stopped || generation !== mine) break;
            if (readingScroll !== scrollRevision || readingRevision !== revision) { work.notify(); continue; }
            const error = results.find(result => result.status === 'rejected');
            if (error) throw error.reason;
            activeStream = stream;
            const [geometry, result, , info, , layoutResult] = results.map(result => result.value);
            if (geometry.pane_visible && geometry.cell_width_px && geometry.cell_height_px) {
              const layout = layoutResult.layout;
              const rect = layout.zoomed ? layout.area : layout.panes.find(item => item.pane_id === pane)?.rect;
              const paneCols = rect?.width;
              if (!Number.isSafeInteger(paneCols) || paneCols <= 0) throw new RangeError('Pane width unavailable.');
              const text = result.read.text;
              const key = JSON.stringify([text, geometry.cell_width_px, geometry.cell_height_px, paneCols]);
              const signature = JSON.stringify([key, readingRevision, readingScroll]);
              if (signature !== previous) {
                let frame = frames.get(key);
                if (!frame) {
                  frame = renderFrame(text, geometry.cell_width_px, geometry.cell_height_px, paneCols);
                  frames.set(key, frame, frame.pixels.length);
                }
                pendingScroll = undefined;
                lastFrame = frame;
                anchor = info.pane.scroll.offset_from_bottom - info.pane.scroll.max_offset_from_bottom;
                await stream.send(frame, 0);
                await new Promise(resolve => setTimeout(resolve, 20));
                if (!stopped && generation === mine && readingScroll === scrollRevision) await stream.send(frame, 0);
                previous = signature;
              }
            } else previous = undefined;
          } catch (error) {
            if (stopped || generation !== mine) break;
            if (!(error instanceof RangeError) && !['not_found', 'pane_not_found', 'cell_size_unavailable', 'feature_disabled', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(error.code)) throw error;
            pendingScroll = undefined;
            lastFrame = undefined;
            stream?.close();
            stream = undefined;
            scrollEvents?.destroy();
            scrollEvents = undefined;
            scrollOpening = undefined;
            previous = undefined;
          }
        }
      } finally {
        clearTimeout(scrollTimer);
        pendingScroll = undefined;
        scrollEvents?.destroy();
        (await scrollOpening?.catch(() => undefined))?.destroy();
        stream?.close();
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
      activeStream?.close();
      activeStream = undefined;
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
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (failure) throw failure;
  } catch (error) {
    if (!stopped || error.code !== 'ABORT_ERR') throw error;
    if (failure) throw failure;
  } finally {
    stop();
    subscription?.destroy();
    activeStream?.close();
    await Promise.all(tasks);
    control.close();
  }
}
