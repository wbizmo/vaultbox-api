class BoundedTtlMap {
  constructor({ maxEntries = 10000, cleanupIntervalMs = 30000, now = Date.now } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer");
    }
    if (!Number.isFinite(cleanupIntervalMs) || cleanupIntervalMs < 1) {
      throw new Error("cleanupIntervalMs must be positive");
    }

    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.cleanupTimer = setInterval(() => this.sweepExpired(), cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  get size() {
    return this.entries.size;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key, value, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("ttlMs must be positive");
    }

    if (this.entries.has(key)) this.entries.delete(key);

    if (this.entries.size >= this.maxEntries) {
      this.sweepExpired();
    }

    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }

    this.entries.set(key, {
      value,
      expiresAt: this.now() + ttlMs
    });

    return this;
  }

  delete(key) {
    return this.entries.delete(key);
  }

  sweepExpired(now = this.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  clear() {
    this.entries.clear();
  }

  close() {
    clearInterval(this.cleanupTimer);
  }
}

module.exports = { BoundedTtlMap };
