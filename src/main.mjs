import net from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { request, sendFrame } from './herdr.mjs';
import { renderFrame } from './math.mjs';

const path = process.env.HERDR_SOCKET_PATH;
const pane = process.env.HERDR_PANE_ID;
if (!path || !pane) throw new Error('Run the Herdr Math action in the pane to render.');
const key = createHash('sha256').update(`${path}\0${pane}`).digest('hex').slice(0, 20);
const controlPath = `${tmpdir()}/herdr-math-${key}.sock`;

const running = await new Promise((resolve, reject) => {
  const socket = net.createConnection(controlPath);
  socket.on('connect', () => { socket.end('stop'); resolve(true); });
  socket.on('error', error => error.code === 'ENOENT' ? resolve(false) : reject(error));
});
if (!running) {
  let stopped = false;
  const control = net.createServer(socket => {
    socket.once('data', () => { stopped = true; socket.end(); });
  });
  await new Promise((resolve, reject) => control.once('error', reject).listen(controlPath, resolve));
  const stop = () => { stopped = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    await request(path, 'pane.graphics.info', { pane_id: pane });
    let previous;
    let frame;
    while (!stopped) {
      const [geometry, result, layout] = await Promise.all([
        request(path, 'pane.graphics.info', { pane_id: pane }),
        request(path, 'pane.read', { pane_id: pane, source: 'visible', lines: 10000 }),
        request(path, 'pane.layout', { pane_id: pane }),
      ]);
      if (geometry.pane_visible && geometry.cell_width_px && geometry.cell_height_px) {
        const text = result.read.text;
        const signature = JSON.stringify([text, geometry.cell_width_px, geometry.cell_height_px, layout.layout]);
        if (signature !== previous) {
          frame = renderFrame(text, geometry.cell_width_px, geometry.cell_height_px);
          const latest = await request(path, 'pane.read', { pane_id: pane, source: 'visible', lines: 10000 });
          if (latest.read.text === text && !stopped) {
            previous = signature;
          } else frame = undefined;
        }
        // Re-present cached pixels: terminal redraws can erase a placement
        // without changing the visible text or geometry.
        if (frame && !stopped) await sendFrame(path, pane, frame);
      } else previous = undefined;
      await delay(200);
    }
  } catch (error) {
    if (error.code !== 'not_found') throw error;
  } finally {
    control.close();
    await request(path, 'pane.graphics.clear', { pane_id: pane, layer_id: 'herdr-math' })
      .catch(() => {}); // Pane/server may already have exited.
  }
}
