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

export function subscribe(path, subscriptions, onEvent) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let pending = '';
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('Herdr closed the connection.')));
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'events', method: 'events.subscribe',
      params: { subscriptions } }) + '\n'));
    socket.on('data', data => {
      pending += data;
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n');
        const message = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (message.error) {
          socket.destroy();
          reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        }
        else if (message.result) resolve(socket);
        else onEvent(message);
      }
    });
  });
}

export function openGraphicsStream(path, pane) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let pending = '';
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('Herdr closed the connection.')));
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'graphics', method: 'pane.graphics.stream',
      params: { pane_id: pane, layer_id: 'herdr-math' } }) + '\n'));
    const receive = data => {
      pending += data;
      if (!pending.includes('\n')) return;
      const response = JSON.parse(pending.slice(0, pending.indexOf('\n')));
      if (response.error) {
        socket.destroy();
        reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
      } else {
        socket.off('data', receive);
        resolve({
          close: () => socket.destroy(),
          send: (frame, row) => new Promise((resolve, reject) => {
            const header = { format: 'rgba', image_width: frame.width, image_height: frame.height,
              data_length: frame.pixels.length,
              placement: { viewport_col: 0, viewport_row: row, grid_cols: frame.cols, grid_rows: frame.rows } };
            socket.write(Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), frame.pixels]),
              error => error ? reject(error) : resolve());
          }),
        });
      }
    };
    socket.on('data', receive);
  });
}
