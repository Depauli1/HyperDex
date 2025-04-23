// Simple mock for p-queue to avoid ESM issues in tests
class PQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 1;
    this.pending = 0;
    this.size = 0;
    this.queue = [];
  }

  add(fn) {
    this.size++;
    this.queue.push(fn);
    this._next();
    return Promise.resolve();
  }

  _next() {
    if (this.pending >= this.concurrency || this.queue.length === 0) {
      return;
    }
    
    const fn = this.queue.shift();
    this.pending++;
    this.size--;
    
    Promise.resolve(fn())
      .finally(() => {
        this.pending--;
        this._next();
      });
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this._next();
  }

  clear() {
    this.queue = [];
    this.size = 0;
  }
}

module.exports = { default: PQueue };
