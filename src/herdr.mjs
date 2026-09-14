import net from 'node:net';

export function request(path, method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let pending = '';
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('Herdr closed the connection.')));
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'math', method, params }) + '\n'));
    socket.on('data', data => {
      pending += data;
      if (!pending.includes('\n')) return;
      const response = JSON.parse(pending.slice(0, pending.indexOf('\n')));
      if (response.error) {
        socket.destroy();
        reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
      } else {
        socket.end();
        resolve(response.result);
      }
    });
  });
}

export function sendFrame(path, pane, frame) {
  return request(path, 'pane.graphics.set', {
    pane_id: pane, layer_id: 'herdr-math',
    format: 'png', image_width: frame.width, image_height: frame.height,
    data_base64: frame.png.toString('base64'),
    placement: { viewport_col: 0, viewport_row: 0, grid_cols: frame.cols, grid_rows: frame.rows },
  });
}
