/**
 * lib/response-cache.js — small, dependency-free caching primitives.
 *
 *  - TTLCache:   bounded (LRU-evicting) in-process key→value cache with per-set TTL.
 *  - memoTTL:    wrap an async producer with TTL caching + single-flight, so N
 *                concurrent callers for the same key trigger exactly ONE producer
 *                run (kills the cold-cache thundering-herd / double-fetch bugs).
 *  - etagJson:   send a JSON response with a strong ETag + Cache-Control and
 *                answer conditional requests with 304 (skips re-download).
 *
 * Everything is synchronous-friendly and fully unit-testable without a server.
 */
const crypto = require('crypto');

class TTLCache {
  constructor({ ttlMs = 60_000, max = 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map(); // key -> { value, expires }
  }
  /** Returns the value if present AND unexpired, else undefined. */
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= Date.now()) { this.map.delete(key); return undefined; }
    // refresh LRU recency
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  has(key) { return this.get(key) !== undefined; }
  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    // evict oldest while over capacity
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return value;
  }
  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

/**
 * Wrap an async producer with TTL caching + single-flight.
 * @param {(key:string, ...args)=>Promise<any>} producer
 * @param {{ttlMs?:number, max?:number, negativeTtlMs?:number, staleMs?:number, keyFn?:Function}} opts
 *   negativeTtlMs: cache empty/null results only this long (default: do not
 *   cache empty results — avoids pinning an API outage for the full TTL).
 *   staleMs: stale-while-revalidate window. After ttlMs the entry is "stale"
 *   for this long: callers get the stale value instantly while ONE background
 *   refresh runs. Past ttlMs+staleMs the entry is gone and callers block as
 *   usual. A failed background refresh keeps the stale value in place.
 * @returns {(key:string, ...args)=>Promise<any>}
 */
function memoTTL(producer, opts = {}) {
  const { ttlMs = 60_000, max = 1000, negativeTtlMs = 0, staleMs = 0, keyFn } = opts;
  const cache = new TTLCache({ ttlMs, max });
  const inflight = new Map(); // key -> Promise

  const isEmpty = (v) =>
    v == null ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

  // With staleMs, entries are stored wrapped so freshness survives past ttlMs.
  const wrap = (v) => (staleMs > 0 ? { value: v, freshUntil: Date.now() + ttlMs } : v);
  const unwrap = (e) => (staleMs > 0 ? e.value : e);

  function refresh(key, args) {
    const p = (async () => {
      const value = await producer(...args);
      if (isEmpty(value)) {
        if (negativeTtlMs > 0) cache.set(key, wrap(value), negativeTtlMs);
      } else {
        cache.set(key, wrap(value), staleMs > 0 ? ttlMs + staleMs : ttlMs);
      }
      return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function run(...args) {
    const key = keyFn ? keyFn(...args) : String(args[0]);
    const hit = cache.get(key);
    if (hit !== undefined) {
      if (staleMs > 0 && Date.now() > hit.freshUntil && !inflight.has(key)) {
        // Stale: serve instantly, refresh in the background (single-flight; a
        // failure just leaves the stale value for the next caller).
        refresh(key, args).catch(() => {});
      }
      return unwrap(hit);
    }
    if (inflight.has(key)) return inflight.get(key);
    return refresh(key, args);
  }
  run.cache = cache;
  run.inflightCount = () => inflight.size;
  return run;
}

/** Strong ETag for an arbitrary JSON-serialisable payload. */
function etagFor(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return '"' + crypto.createHash('sha1').update(body).digest('base64') + '"';
}

/**
 * Send JSON with an ETag + Cache-Control, honouring If-None-Match (→ 304).
 * @param {{maxAge?:number, isPrivate?:boolean, staleWhileRevalidate?:number}} opts
 */
function etagJson(req, res, payload, opts = {}) {
  const { maxAge = 30, isPrivate = true, staleWhileRevalidate } = opts;
  const body = JSON.stringify(payload);
  const tag = etagFor(body);
  const scope = isPrivate ? 'private' : 'public';
  let cc = `${scope}, max-age=${maxAge}`;
  if (staleWhileRevalidate != null) cc += `, stale-while-revalidate=${staleWhileRevalidate}`;
  res.setHeader('Cache-Control', cc);
  res.setHeader('ETag', tag);
  const inm = req.headers['if-none-match'];
  if (inm && inm === tag) { res.status(304).end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(res.statusCode || 200).send(body);
}

module.exports = { TTLCache, memoTTL, etagFor, etagJson };
