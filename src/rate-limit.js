// FIX 13 (M1): in-memory rate limiter with periodic eviction of stale
// entries — the Map previously grew without bound on public traffic.
const hits = new Map();

function sweep(windowMs) {
  const now = Date.now();
  for (const [key, rec] of hits) {
    if (now - rec.start > windowMs) hits.delete(key);
  }
}

// Test hook: current tracked key count.
export function hitsSize() {
  return hits.size;
}

export function rateLimit({ max = 100, windowMs = 60_000 } = {}) {
  const sweeper = setInterval(() => sweep(windowMs), windowMs);
  sweeper.unref();
  return (req, res, next) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
}
