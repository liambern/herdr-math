// Events request the next available render slot; repeated events cannot postpone it.
export class RenderSchedule {
  constructor(signal, fallbackMs = 1000, frameMs = 16) {
    this.signal = signal;
    this.fallbackMs = fallbackMs;
    this.frameMs = frameMs;
    this.due = 0;
    this.nextFrame = 0;
  }
  notify() {
    this.due = 0;
    this.wake?.();
  }
  async wait() {
    while (!this.signal.aborted) {
      const remaining = Math.max(this.due, this.nextFrame) - performance.now();
      if (remaining <= 0) {
        const now = performance.now();
        this.nextFrame = now + this.frameMs;
        this.due = now + this.fallbackMs;
        return;
      }
      await new Promise(resolve => {
        const done = () => {
          clearTimeout(timer);
          this.signal.removeEventListener('abort', done);
          this.wake = undefined;
          resolve();
        };
        const timer = setTimeout(done, remaining);
        this.wake = done;
        this.signal.addEventListener('abort', done, { once: true });
      });
    }
  }
}
