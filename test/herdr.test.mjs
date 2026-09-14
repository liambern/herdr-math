import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request, subscribe, openGraphicsStream } from '../src/herdr.mjs';

test('an interrupted Herdr connection rejects instead of hanging', async () => {
  const directory = await mkdtemp(`${tmpdir()}/herdr-math-rpc-`);
  const path = `${directory}/socket`;
  const server = net.createServer(socket => { socket.resume(); socket.end(); });
  await new Promise(resolve => server.listen(path, resolve));
  try {
    await assert.rejects(request(path, 'ping', {}), /closed the connection/);
    await assert.rejects(subscribe(path, [{ type: 'pane.focused' }], () => {}), /closed the connection/);
    await assert.rejects(openGraphicsStream(path, 'pane'), /closed the connection/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
  }
});

async function peer(t, reply) {
  const directory = await mkdtemp(`${tmpdir()}/herdr-math-protocol-`);
  const path = `${directory}/socket`;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => reply(socket));
  });
  await new Promise(resolve => server.listen(path, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
  });
  return path;
}

test('malformed replies reject without an uncaught exception', async t => {
  const path = await peer(t, socket => socket.end('{broken}\n'));
  await assert.rejects(request(path, 'ping', {}), SyntaxError);
  await assert.rejects(subscribe(path, [], () => {}), SyntaxError);
  await assert.rejects(openGraphicsStream(path, 'pane'), SyntaxError);
});

test('stalled handshakes time out and can be cancelled', async t => {
  const path = await peer(t, () => {});
  await assert.rejects(request(path, 'ping', {}, { timeoutMs: 30 }), { code: 'ETIMEDOUT' });
  const controller = new AbortController();
  const pending = request(path, 'ping', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
});

test('UTF-8 characters survive split socket packets', async t => {
  const path = await peer(t, socket => {
    const bytes = Buffer.from(JSON.stringify({ result: 'Ψ' }) + '\n');
    const cut = bytes.indexOf(Buffer.from('Ψ')) + 1;
    socket.write(bytes.subarray(0, cut));
    setTimeout(() => socket.end(bytes.subarray(cut)), 10);
  });
  assert.equal(await request(path, 'ping', {}), 'Ψ');
});

test('oversized unterminated replies are rejected', async t => {
  const path = await peer(t, socket => socket.end('x'.repeat(8 * 1024 * 1024 + 1)));
  await assert.rejects(request(path, 'ping', {}), /size limit/);
});
