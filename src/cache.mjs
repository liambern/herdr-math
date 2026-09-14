// Least-recently-used cache with both entry and byte limits.
export class Cache {
  #entries = new Map();
  bytes = 0;
  constructor(maxBytes, maxEntries = 128) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }
  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }
  set(key, value, bytes) {
    if (this.#entries.has(key)) {
      this.bytes -= this.#entries.get(key).bytes;
      this.#entries.delete(key);
    }
    if (bytes > this.maxBytes) return;
    while (this.#entries.size && (this.bytes + bytes > this.maxBytes || this.#entries.size >= this.maxEntries)) {
      const oldest = this.#entries.keys().next().value;
      this.bytes -= this.#entries.get(oldest).bytes;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, { value, bytes });
    this.bytes += bytes;
  }
}
