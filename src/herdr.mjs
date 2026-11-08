import { wireFrame } from './png.mjs';
import net from 'node:net';
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

// One image per pane terminal; transmitting the same id replaces the previous frame and placement.
const IMAGE_ID = 1832177;
const WINSIZE = 'import fcntl,os,struct,sys,termios\n'
  + 'fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOCTTY)\n'
  + 'print(*struct.unpack("4H",fcntl.ioctl(fd,termios.TIOCGWINSZ,bytes(8))))';

export const kittyClear = () => `\x1b_Ga=d,d=I,i=${IMAGE_ID},q=2\x1b\\`;

// Place the frame at its cell position and restore the cursor; q=2 keeps replies out of the pane's input.
export function kittyFrame(frame) {
  if (!frame.placements.length) return kittyClear();
  const wire = wireFrame(frame);
  const data = wire.data.toString('base64');
  let out = `\x1b7\x1b[${wire.row + 1};${wire.col + 1}H`;
  for (let i = 0; i < data.length; i += 4096) {
    const keys = i ? 'q=2' : `a=T,f=100,i=${IMAGE_ID},c=${wire.cols},r=${wire.rows},C=1,q=2`;
    out += `\x1b_G${keys},m=${i + 4096 < data.length ? 1 : 0};${data.slice(i, i + 4096)}\x1b\\`;
  }
  return out + '\x1b8';
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
  let closed = false;
  return {
    size() {
      const [rows, cols, width, height] = execFileSync('python3', ['-c', WINSIZE, tty], { encoding: 'utf8' }).trim().split(' ').map(Number);
      return { cols, cellWidth: Math.round(width / cols), cellHeight: Math.round(height / rows) };
    },
    send: frame => writeSync(fd, kittyFrame(frame)),
    close() {
      if (closed) return;
      closed = true;
      try { writeSync(fd, kittyClear()); } catch { /* The pane closed first. */ }
      closeSync(fd);
    },
  };
}
