import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request, subscribe, paneGraphicsState } from '../src/herdr.mjs';
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

const commands = out => [...out.matchAll(/\x1b_G([^;\x1b]*)(?:;[^\x1b]*)?\x1b\\/g)].map(match => match[1]);

test('equations are uploaded once, placed at their cells, and unchanged frames write nothing', () => {
  const state = paneGraphicsState();
  const text = 'prose $x^2$ here\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n';
  const frame = renderFrame(text, 9, 20, 40);
  const out = state.update(frame);
  assert(out.startsWith('\x1b7') && out.endsWith('\x1b8'), 'cursor saved and restored');
  const keys = commands(out);
  assert.equal(keys.filter(key => key.startsWith('a=t,f=100,')).length, 2, 'one upload per equation');
  assert.equal(keys.filter(key => key.startsWith('a=p,')).length, 2, 'one placement per equation');
  assert(keys.every(key => key.includes('q=2')), 'terminal replies stay off');
  const display = frame.placements.find(p => !p.inline);
  assert(out.includes(`\x1b[${display.row + 1};${display.col + 1}H\x1b_Ga=p,`), 'placed at the equation cell');
  assert.equal(state.update(renderFrame(text.replace('here', 'there'), 9, 20, 40)), '', 'unrelated text changes write nothing');
});

test('moved equations are re-placed without re-uploading, and vanished ones are deleted', () => {
  const state = paneGraphicsState();
  const text = '$$\nE = mc^2\n$$\n';
  state.update(renderFrame(text, 9, 20, 40));
  const moved = commands(state.update(renderFrame('\n\n' + text, 9, 20, 40)));
  assert.deepEqual(moved.map(key => key.slice(0, 4)), ['a=p,'], 'a move is a single placement update');
  const gone = commands(state.update(renderFrame('no math\n', 9, 20, 40)));
  assert(gone.some(key => key.startsWith('a=d,d=i,')) && gone.some(key => key.startsWith('a=d,d=I,')), gone.join(' | '));
  const back = commands(state.update(renderFrame('$$\np = mv\n$$\n', 9, 20, 40)));
  assert.equal(back.filter(key => key.startsWith('a=t,')).length, 1, 'a new equation uploads once');
});
