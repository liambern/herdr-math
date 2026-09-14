import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request } from '../src/herdr.mjs';

test('an interrupted Herdr connection rejects instead of hanging', async () => {
  const directory = await mkdtemp(`${tmpdir()}/herdr-math-rpc-`);
  const path = `${directory}/socket`;
  const server = net.createServer(socket => { socket.resume(); socket.end(); });
  await new Promise(resolve => server.listen(path, resolve));
  try {
    await assert.rejects(request(path, 'ping', {}), /closed the connection/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
  }
});
