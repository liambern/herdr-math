import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { RenderSchedule } from '../src/schedule.mjs';

test('continuous events render at bounded intervals without waiting for quiet', async () => {
  const controller = new AbortController();
  const schedule = new RenderSchedule(controller.signal, 1000, 16);
  const times = [];
  const consumer = (async () => {
    while (!controller.signal.aborted) {
      await schedule.wait();
      if (!controller.signal.aborted) times.push(performance.now());
    }
  })();
  const events = setInterval(() => schedule.notify(), 2);
  try {
    await delay(200);
    assert(times.length >= 3, 'rendering must progress before events stop');
    for (let i = 1; i < times.length; i++) {
      assert(times[i] - times[i - 1] >= 15, 'events must not bypass the frame rate limit');
    }
  } finally {
    clearInterval(events);
    controller.abort();
    await consumer;
  }
});

test('an event received during rendering stays pending for the next slot', async () => {
  const controller = new AbortController();
  const schedule = new RenderSchedule(controller.signal, 1000, 16);
  await schedule.wait();
  schedule.notify();
  await delay(20);
  let released = false;
  const pending = schedule.wait().then(() => { released = true; });
  await Promise.resolve();
  assert(released, 'pending work must not wait for another event or fallback');
  await pending;
  controller.abort();
});
