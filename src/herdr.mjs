import { encodePNG } from './png.mjs';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
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

const WINSIZE = 'import fcntl,os,struct,sys,termios\n'
  + 'fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOCTTY)\n'
  + 'print(*struct.unpack("4H",fcntl.ioctl(fd,termios.TIOCGWINSZ,bytes(8))))';

// Each distinct equation tile is one Kitty image whose id derives from its content.
const imageId = key => (createHash('sha1').update(key).digest().readUInt32BE(0) & 0x0fffffff) | 0x60000000;

function transmit(id, tile) {
  const data = encodePNG(tile.pixels, tile.width, tile.height).toString('base64');
  let out = '';
  for (let i = 0; i < data.length; i += 4096) {
    const keys = i ? 'q=2' : `a=t,f=100,i=${id},q=2`;
    out += `\x1b_G${keys},m=${i + 4096 < data.length ? 1 : 0};${data.slice(i, i + 4096)}\x1b\\`;
  }
  return out;
}

// Graphics on one pane terminal. Equations are uploaded once, re-placed only when they move, and
// nothing is written when they are unchanged, so redraws elsewhere in the pane (spinners, timers,
// input) cannot make Herdr re-send images. q=2 keeps replies out of the pane's input; the cursor
// is saved and restored around placements.
export function paneGraphicsState() {
  let placed = new Map();
  const images = new Set();
  return {
    update(frame) {
      let out = '';
      const desired = new Map();
      const copies = new Map();
      for (const p of frame.placements) {
        const id = imageId(p.tile.key);
        const n = (copies.get(id) ?? 0) + 1;
        copies.set(id, n);
        if (!images.has(id)) { out += transmit(id, p.tile); images.add(id); }
        const where = `${p.row},${p.col},${p.cols},${p.rows}`;
        desired.set(`${id}:${n}`, where);
        if (placed.get(`${id}:${n}`) !== where) out += `\x1b[${p.row + 1};${p.col + 1}H\x1b_Ga=p,i=${id},p=${n},c=${p.cols},r=${p.rows},C=1,q=2\x1b\\`;
      }
      for (const key of placed.keys()) {
        if (desired.has(key)) continue;
        const [id, n] = key.split(':');
        out += `\x1b_Ga=d,d=i,i=${id},p=${n},q=2\x1b\\`;
      }
      for (const id of images) {
        if (copies.has(id)) continue;
        out += `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
        images.delete(id);
      }
      placed = desired;
      return out && `\x1b7${out}\x1b8`;
    },
    clear() {
      const out = [...images].map(id => `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`).join('');
      images.clear();
      placed = new Map();
      return out;
    },
  };
}

// Herdr 0.9.2 removed pane.graphics.*; it renders Kitty graphics written to a pane's own terminal.
// Each frame is one write(), which the kernel keeps whole relative to the application's own output.
export async function openPaneGraphics(path, pane, options) {
  const { process_info: info } = await request(path, 'pane.process_info', { pane_id: pane }, options);
  let name = '';
  try { name = execFileSync('ps', ['-o', 'tty=', '-p', String(info.shell_pid)], { encoding: 'utf8' }).trim(); }
  catch { /* The pane's shell has exited. */ }
  if (!name || name.startsWith('?')) throw Object.assign(new Error('Pane terminal unavailable.'), { code: 'pane_not_found' });
  const tty = `/dev/${name}`;
  const fd = openSync(tty, constants.O_WRONLY | constants.O_NOCTTY);
  const state = paneGraphicsState();
  let closed = false;
  return {
    size() {
      const [rows, cols, width, height] = execFileSync('python3', ['-c', WINSIZE, tty], { encoding: 'utf8' }).trim().split(' ').map(Number);
      return { cols, cellWidth: Math.round(width / cols), cellHeight: Math.round(height / rows) };
    },
    send(frame) {
      const out = state.update(frame);
      if (out) writeSync(fd, out);
    },
    close() {
      if (closed) return;
      closed = true;
      const out = state.clear();
      try { if (out) writeSync(fd, out); } catch { /* The pane closed first. */ }
      closeSync(fd);
    },
  };
}
