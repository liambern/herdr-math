import { spawn } from 'node:child_process';

// Real pseudo-terminals for fake Herdr panes; records the Kitty graphics commands written to each.
export function fakePanes() {
  const panes = new Map();
  const events = [];
  function open(name) {
    const child = spawn('python3', ['test/fake-pane.py'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buffer = '';
    let ready;
    const pane = { child, pid: new Promise(resolve => { ready = resolve; }), heads: [] };
    child.stdout.setEncoding('latin1');
    child.stdout.on('data', data => {
      buffer += data;
      if (ready) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        ready(Number(buffer.slice(0, end)));
        ready = undefined;
        buffer = buffer.slice(end + 1);
      }
      let last = 0;
      for (const match of buffer.matchAll(/\x1b_Ga=([Td])[^;\x1b]*(?:;[A-Za-z0-9+/=]{0,16})?/g)) {
        events.push({ type: match[1] === 'T' ? 'frame' : 'clear', pane: name });
        if (match[1] === 'T') pane.heads.push(match[0]);
        last = match.index + match[0].length;
      }
      buffer = buffer.slice(Math.max(last, buffer.length - 64));
    });
    panes.set(name, pane);
    return pane;
  }
  return {
    events,
    pid: name => (panes.get(name) ?? open(name)).pid,
    heads: name => panes.get(name)?.heads ?? [],
    frames: name => events.filter(event => event.type === 'frame' && event.pane === name).length,
    clears: name => events.filter(event => event.type === 'clear' && event.pane === name).length,
    index: (type, name) => events.findIndex(event => event.type === type && event.pane === name),
    close: () => { for (const pane of panes.values()) pane.child.kill(); },
  };
}
