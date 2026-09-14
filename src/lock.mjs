import net from 'node:net';
import { lstat, unlink } from 'node:fs/promises';

async function listening(path) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.setTimeout(1000, () => socket.destroy(new Error('Renderer lock probe timed out.')));
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(false);
      else reject(error);
    });
  });
}

// Only remove the same stale socket we inspected; never delete ordinary files.
export async function acquireLock(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = await lstat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (await listening(path)) return null;
    if (before) {
      if (!before.isSocket() || (process.getuid && before.uid !== process.getuid())) {
        throw new Error('Renderer lock path is not an owned socket.');
      }
      const after = await lstat(path).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!after || before.ino !== after.ino || before.dev !== after.dev) continue;
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const server = net.createServer(socket => socket.end());
    const acquired = await new Promise((resolve, reject) => {
      server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
      server.listen(path, () => resolve(true));
    });
    if (acquired) return server;
  }
  throw new Error('Could not acquire renderer lock.');
}
