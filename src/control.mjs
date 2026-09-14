import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

export function controlPath(path) {
  const key = createHash('sha256').update(path).digest('hex').slice(0, 20);
  return `${tmpdir()}/herdr-math-${key}.sock`;
}

export function handleControl(socket, toggle) {
  let pending = '';
  socket.setTimeout(1000, () => socket.destroy());
  socket.on('error', () => {});
  const receive = data => {
    pending += data;
    if (pending.length > 1024) { socket.destroy(); return; }
    if (!pending.includes('\n')) return;
    socket.off('data', receive);
    try {
      const message = JSON.parse(pending.slice(0, pending.indexOf('\n')));
      if (message.method !== 'toggle') throw new Error('Unknown renderer command.');
      socket.end(JSON.stringify({ id: message.id, result: { visible: toggle() } }) + '\n');
    } catch { socket.destroy(); }
  };
  socket.on('data', receive);
}
