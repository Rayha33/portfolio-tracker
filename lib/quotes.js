/*
 * quotes.js — free underlying-equity quotes & history (Yahoo Finance + FRED).
 *
 * No API key required. Everything is cached in-process and fails soft: if the
 * network is unavailable the callers fall back to the marks stored with each
 * position, so the app still works fully offline (just with frozen prices).
 *
 * Set ENABLE_LIVE_QUOTES=0 to skip all network calls.
 */
const LIVE = process.env.ENABLE_LIVE_QUOTES !== '0';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const spotCache = new Map(); // ticker -> { value, expires }
const histCache = new Map(); // ticker -> { value, expires }
const SPOT_TTL = 60 * 1000;
const HIST_TTL = 6 * 60 * 60 * 1000;
// Failed/empty fetches are cached only briefly so a transient error (e.g. a
// Yahoo rate-limit) self-heals on the next request instead of pinning a null.
const NEG_TTL = 30 * 1000;

function cacheGet(map, key) {
  const e = map.get(key);
  if (e && e.expires > Date.now()) return e.value;
  return undefined;
}
const CACHE_MAX = 500; // plenty for a single-user book; guards against unbounded growth
function cacheSet(map, key, value, ttl) {
  map.set(key, { value, expires: Date.now() + ttl });
  if (map.size > CACHE_MAX) {
    const oldest = map.keys().next().value; // Maps preserve insertion order
    map.delete(oldest);
  }
  return value;
}

async function fetchJson(url, timeoutMs = 6000) {
  if (typeof fetch !== 'function') return null; // Node < 18
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url, timeoutMs = 6000) {
  if (typeof fetch !== 'function') return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// App ticker → Yahoo symbol. Indices keep their ^ prefix (^VIX); equities are
// used as-is. Yahoo wants the ^ URL-encoded.
function yahooSymbol(ticker) {
  return String(ticker || '').trim().toUpperCase();
}

async function fetchChart(ticker, range) {
  const sym = encodeURIComponent(yahooSymbol(ticker));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=${range}`;
  const j = await fetchJson(url);
  const r = j && j.chart && Array.isArray(j.chart.result) ? j.chart.result[0] : null;
  return r || null;
}

/* Latest spot price for a ticker, or null. Cached 60s. */
async function getSpot(ticker) {
  const key = String(ticker || '').toUpperCase();
  if (!key) return null;
  const hit = cacheGet(spotCache, key);
  if (hit !== undefined) return hit;
  if (!LIVE) return cacheSet(spotCache, key, null, SPOT_TTL);

  const r = await fetchChart(key, '5d');
  let price = null;
  if (r && r.meta && isFinite(r.meta.regularMarketPrice) && r.meta.regularMarketPrice > 0) {
    price = Number(r.meta.regularMarketPrice);
  }
  return cacheSet(spotCache, key, price, price == null ? NEG_TTL : SPOT_TTL);
}

/* Daily close history (most-recent last) as [{date, close}], or []. Cached 6h. */
async function getHistory(ticker, range = '6mo') {
  const key = String(ticker || '').toUpperCase() + ':' + range;
  if (!ticker) return [];
  const hit = cacheGet(histCache, key);
  if (hit !== undefined) return hit;
  if (!LIVE) return cacheSet(histCache, key, [], HIST_TTL);

  const r = await fetchChart(ticker, range);
  const out = [];
  if (r && Array.isArray(r.timestamp) && r.indicators && r.indicators.quote && r.indicators.quote[0]) {
    const closes = r.indicators.quote[0].close || [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const c = closes[i];
      if (c == null || !isFinite(c)) continue;
      const date = new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10);
      out.push({ date, close: Number(c) });
    }
  }
  return cacheSet(histCache, key, out, out.length ? HIST_TTL : NEG_TTL);
}

/* Annualized realized volatility from ~30 trading days, or null. */
async function getRealizedVol(ticker) {
  const hist = await getHistory(ticker, '2mo');
  if (!hist || hist.length < 12) return null;
  const closes = hist.map((d) => d.close).filter((x) => isFinite(x) && x > 0);
  if (closes.length < 12) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
  const annual = Math.sqrt(variance) * Math.sqrt(252);
  return isFinite(annual) && annual > 0 ? annual : null;
}

/* VIX history as [{date, close}] (most-recent last). */
async function getVixHistory() {
  return getHistory('^VIX', '6mo');
}

const fredCache = new Map();
/* FRED series as [{date, value}] — used for the VIX 3M term-structure read. */
async function getFredSeries(id) {
  const key = String(id || '').toUpperCase();
  if (!key) return [];
  const hit = cacheGet(fredCache, key);
  if (hit !== undefined) return hit;
  if (!LIVE) return cacheSet(fredCache, key, [], HIST_TTL);

  const csv = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(key)}`);
  const out = [];
  if (csv) {
    const lines = csv.trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const date = cols[0];
      const value = parseFloat(cols[1]);
      if (date && isFinite(value)) out.push({ date, value });
    }
  }
  return cacheSet(fredCache, key, out.slice(-260), out.length ? HIST_TTL : NEG_TTL);
}

module.exports = { getSpot, getHistory, getRealizedVol, getVixHistory, getFredSeries, LIVE };
