#!/usr/bin/env node
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from '../src/herdr.mjs';
import { renderFrame } from '../src/math.mjs';

const sample = String.raw`
  HERDR MATH — terminal rendering check

  Variational energy

  $$
  E = \frac{\langle\Psi|H|\Psi\rangle}{\langle\Psi|\Psi\rangle}
  $$

  The paragraph below the fraction stays in its original position.

  Imaginary-time propagation

  \[
  \Psi(\tau) = e^{-\tau H}\Psi(0)
  \]

  Two coupled equations

  \begin{align*}
  i\hbar\,\partial_t\psi &= H\psi \\
  \langle A\rangle &= \frac{\langle\psi|A|\psi\rangle}{\langle\psi|\psi\rangle}
  \end{align*}

  Inline $x^2$ stays text. The command prompt stays untouched.

  > Ready
`;
const path = process.env.HERDR_SOCKET_PATH;
const pane = process.env.HERDR_PANE_ID;
writeFileSync('artifacts/test-context.json', JSON.stringify({ path, pane }));
process.stdout.write('\x1b[2J\x1b[H' + sample);
await delay(1500);
const worker = spawn(process.execPath, ['src/main.mjs'], { stdio: ['ignore', 'ignore', 'pipe'] });
worker.stderr.on('data', data => writeFileSync('artifacts/worker-error.log', data));
await delay(1800);
const geometry = await request(path, 'pane.graphics.info', { pane_id: pane });
const result = await request(path, 'pane.read', { pane_id: pane, source: 'visible', lines: 10000 });
writeFileSync('artifacts/live-snapshot.json', JSON.stringify({ geometry, read: result.read }, null, 2));
const frame = renderFrame(result.read.text, geometry.cell_width_px, geometry.cell_height_px);
writeFileSync('artifacts/equation-layer.png', frame.png);
writeFileSync('artifacts/placements.json', JSON.stringify(frame.placements, null, 2));
writeFileSync('artifacts/live-ready', 'ready');
let command = '';
while (true) {
  if (existsSync('artifacts/live-command')) {
    const next = readFileSync('artifacts/live-command', 'utf8').trim();
    if (next !== command) {
      command = next;
      if (command === 'redraw') process.stdout.write('\x1b[2J\x1b[H\n  All equations removed. This text must have no leftover images.\n\n  > Ready\n');
      if (command === 'restore') process.stdout.write('\x1b[2J\x1b[H' + sample);
      if (command === 'scroll') process.stdout.write('\n'.repeat(10) + '  Output moved upward by ten rows.\n');
      if (command === 'stop') { worker.kill(); break; }
    }
  }
  await delay(200);
}
