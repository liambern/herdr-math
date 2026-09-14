import net from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { request, sendFrame } from './herdr.mjs';

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
  let pane;
  const clear = async () => {
    if (pane) await request(path, 'pane.graphics.clear', { pane_id: pane, layer_id: 'herdr-math' })
      .catch(error => { if (!['not_found', 'pane_not_found'].includes(error.code)) throw error; });
  };
  try {
    const { renderFrame } = await import('./math.mjs');
    let previous;
    let frame;
    const frames = new Map();
    let nextPresentation = 0;
    while (!stopped) {
      try {
        const [{ plugins }, current] = await Promise.all([
          request(path, 'plugin.list', { plugin_id: 'herdr-math' }),
          request(path, 'pane.current', {}),
        ]);
        if (!plugins.some(plugin => plugin.enabled)) break;
        const focused = current.pane?.pane_id;
        if (focused !== pane) {
          await clear();
          pane = focused;
          previous = undefined;
          frame = undefined;
        }
        if (pane) {
          const [geometry, result, layout] = await Promise.all([
            request(path, 'pane.graphics.info', { pane_id: pane }),
            request(path, 'pane.read', { pane_id: pane, source: 'visible', lines: 10000 }),
            request(path, 'pane.layout', { pane_id: pane }),
          ]);
          if (geometry.pane_visible && geometry.cell_width_px && geometry.cell_height_px) {
            const text = result.read.text;
            const signature = JSON.stringify([text, geometry.cell_width_px, geometry.cell_height_px, layout.layout]);
            const changed = signature !== previous;
            if (changed) {
              frame = frames.get(signature);
              if (!frame) {
                frame = renderFrame(text, geometry.cell_width_px, geometry.cell_height_px);
                frames.set(signature, frame);
                if (frames.size > 8) frames.delete(frames.keys().next().value);
              }
              const latest = await request(path, 'pane.read', { pane_id: pane, source: 'visible', lines: 10000 });
              if (latest.read.text === text && !stopped) {
                previous = signature;
              } else frame = undefined;
            }
            // Re-present cached pixels: terminal redraws can erase a placement
            // without changing the visible text or geometry.
            if (frame && !stopped && (changed || Date.now() >= nextPresentation)) {
              await sendFrame(path, pane, frame);
              // A fresh placement needs a prompt second presentation after the redraw.
              nextPresentation = Date.now() + (changed ? 50 : 200);
            }
          } else previous = undefined;
        }
      } catch (error) {
        if (!['not_found', 'pane_not_found', 'cell_size_unavailable', 'feature_disabled'].includes(error.code)) throw error;
        previous = undefined;
        frame = undefined;
      }
      await delay(50);
    }
  } finally {
    control.close();
    await clear().catch(() => {}); // Pane/server may already have exited.
  }
}
