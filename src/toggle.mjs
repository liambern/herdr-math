import { request } from './herdr.mjs';
import { controlPath } from './control.mjs';

const path = process.env.HERDR_SOCKET_PATH;
if (!path) throw new Error('Run this action inside Herdr.');
const control = controlPath(path);
let result;
try {
  result = await request(control, 'toggle', {});
} catch (error) {
  if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  // A fresh worker starts visible, so toggling an absent renderer simply shows it.
  await request(path, 'plugin.action.invoke', { action_id: 'herdr-math.start' });
  result = { visible: true };
}
console.log(result.visible ? 'Math overlays shown.' : 'Math overlays hidden.');
