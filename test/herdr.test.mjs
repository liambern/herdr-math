import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request, subscribe, kittyFrame, kittyClear } from '../src/herdr.mjs';
import { renderFrame } from '../src/math.mjs';

test('an interrupted Herdr connection rejects instead of hanging', async () => {
  const directory = await mkdtemp(`${tmpdir()}/herdr-math-rpc-`);
  const path = `${directory}/socket`;
  const server = net.createServer(socket => { socket.resume(); socket.end(); });
  await new Promise(resolve => server.listen(path, resolve));
  try {
    await assert.rejects(request(path, 'ping', {}), /closed the connection/);
    await assert.rejects(subscribe(path, [{ type: 'pane.focused' }], () => {}), /closed the connection/);
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

test('frames become one Kitty transmission placed at the equation without moving the cursor', () => {
  const frame = renderFrame('text\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n', 9, 20, 40);
  const out = kittyFrame(frame);
  const placement = frame.placements[0];
  assert(out.startsWith(`\x1b7\x1b[${placement.row + 1};${placement.col + 1}H\x1b_Ga=T,f=100,`), out.slice(0, 40));
  assert(out.endsWith('\x1b8'));
  const chunks = [...out.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
  assert(chunks[0][1].includes(`c=${placement.cols},r=${placement.rows},C=1,q=2`), chunks[0][1]);
  assert(chunks[0][2].startsWith('iVBORw0KGgo'), 'payload must be a base64 PNG');
  assert(chunks.slice(1).every(chunk => chunk[1].startsWith('q=2,m=')), 'later chunks only carry q and m');
  assert(chunks.every(chunk => chunk[2].length <= 4096));
  assert.deepEqual(chunks.map(chunk => chunk[1].at(-1)), [...Array(chunks.length - 1).fill('1'), '0']);
});

test('a frame without equations removes the image instead of placing one', () => {
  assert.equal(kittyFrame(renderFrame('no math here\n', 9, 20, 40)), kittyClear());
  assert.match(kittyClear(), /^\x1b_Ga=d,d=I,i=\d+,q=2\x1b\\$/);
});
