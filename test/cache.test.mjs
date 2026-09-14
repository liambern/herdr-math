import test from 'node:test';
import assert from 'node:assert/strict';
import { Cache } from '../src/cache.mjs';

test('recent images survive eviction and memory stays bounded', () => {
  const cache = new Cache(10, 2);
  cache.set('a', 'A', 4);
  cache.set('b', 'B', 4);
  assert.equal(cache.get('a'), 'A');
  cache.set('c', 'C', 4);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.bytes, 8);
  cache.set('large', 'skip', 11);
  assert.equal(cache.bytes, 8);
  assert.equal(cache.get('large'), undefined);
  cache.set('a', 'replacement', 7);
  assert.equal(cache.bytes, 7);
  assert.equal(cache.get('c'), undefined);
});
