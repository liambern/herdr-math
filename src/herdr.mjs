import { wireFrame } from './png.mjs';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

// Bound handshakes even when a peer accepts a connection but never replies.
function connect(path, method, params, { timeoutMs = 5000, signal } = {}, onEvent, keepOpen = false) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let ready = false;
    const fail = error => { reject(error); socket.destroy(); };
    const abort = () => fail(Object.assign(new Error('Herdr operation aborted.'), { code: 'ABORT_ERR' }));
    const timer = setTimeout(() => fail(Object.assign(new Error('Herdr response timed out.'), { code: 'ETIMEDOUT' })), timeoutMs);
    socket.on('error', fail);
    socket.on('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Error('Herdr closed the connection.'));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'math', method, params }) + '\n'));
    socket.on('data', data => {
      pending += decoder.write(data);
      try {
        while (pending.includes('\n')) {
          const end = pending.indexOf('\n');
          if (Buffer.byteLength(pending.slice(0, end)) > MAX_MESSAGE_BYTES) throw new Error('Herdr response exceeds size limit.');
          const message = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          if (!message || typeof message !== 'object') throw new Error('Invalid Herdr response.');
          if (message.error) throw Object.assign(new Error(message.error.message), { code: message.error.code });
          if (!ready) {
            if (!Object.hasOwn(message, 'result')) throw new Error('Missing Herdr response result.');
            ready = true;
            clearTimeout(timer);
            resolve(keepOpen ? socket : message.result);
            if (!keepOpen) { socket.destroy(); return; }
          } else if (onEvent) onEvent(message);
        }
        if (Buffer.byteLength(pending) > MAX_MESSAGE_BYTES) throw new Error('Herdr response exceeds size limit.');
      } catch (error) { fail(error); }
    });
  });
}

export function request(path, method, params, options) {
  return connect(path, method, params, options);
}

export function subscribe(path, subscriptions, onEvent, options) {
  return connect(path, 'events.subscribe', { subscriptions }, options, onEvent, true);
}

export async function openGraphicsStream(path, pane, options) {
  const socket = await connect(path, 'pane.graphics.stream', { pane_id: pane, layer_id: 'herdr-math' }, options, undefined, true);
  return {
    get closed() { return socket.destroyed; },
    close: () => socket.destroy(),
    send: (frame, row) => new Promise((resolve, reject) => {
      if (socket.destroyed) { reject(new Error('Herdr graphics stream closed.')); return; }
      const wire = wireFrame(frame);
      const header = { format: 'png', image_width: wire.width, image_height: wire.height,
        data_length: wire.data.length,
        placement: { viewport_col: wire.col, viewport_row: row + wire.row, grid_cols: wire.cols, grid_rows: wire.rows } };
      const finish = error => {
        clearTimeout(timer);
        socket.off('close', closed);
        error ? reject(error) : resolve();
      };
      const closed = () => finish(new Error('Herdr graphics stream closed.'));
      const timer = setTimeout(() => {
        finish(new Error('Herdr graphics write timed out.'));
        socket.destroy();
      }, options?.timeoutMs ?? 5000);
      socket.once('close', closed);
      socket.write(Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), wire.data]), finish);
    }),
  };
}
