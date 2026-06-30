/*
 * market.js — live(ish) market data with no API keys.
 *
 *  - Underlying equity prices come from Stooq (free).
 *  - Option marks/greeks are computed with Black-Scholes from the underlying
 *    (there is no free options chain). P&L therefore moves with the real stock.
 *  - VIX history + the 3M term-structure read come from Stooq + FRED.
 *
 * Everything fails soft: when the network is unavailable each endpoint returns
 * an empty/neutral payload and the portfolio page keeps the marks stored with
 * each position. Set ENABLE_LIVE_QUOTES=0 to force offline behaviour.
 */
const { Router } = require('express');
const db = require('../lib/db');
const quotes = require('../lib/quotes');
const { priceOption } = require('../lib/options');

const router = Router();

const RISK_FREE_RATE = Number(process.env.RISK_FREE_RATE) || 0.045;
const DEFAULT_IV = Number(process.env.DEFAULT_IV) || 0.55;

// Run an async mapper over items with bounded concurrency, so a page load with
// many tickers doesn't fire a burst of requests at the (rate-limited) free
// quote source all at once.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function betaFor(ticker) {
  try {
    const row = db.prepare('SELECT beta FROM stocks WHERE symbol = ?').get(String(ticker).toUpperCase());
    return row && row.beta != null ? Number(row.beta) : null;
  } catch (e) {
    return null;
  }
}

/* GET /quotes?tickers=AAPL,MSFT — [{ ticker, price, beta }]. */
router.get('/quotes', async (req, res) => {
  try {
    const tickers = String(req.query.tickers || '')
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    if (!tickers.length) return res.json([]);
    const out = await mapLimit([...new Set(tickers)], 3, async (t) => {
      const price = await quotes.getSpot(t);
      return { ticker: t, price: price != null ? price : null, beta: betaFor(t) };
    });
    res.json(out);
  } catch (e) {
    console.error('[market] quotes failed:', e.message);
    res.json([]);
  }
});

/* POST /market/options-prices — body is an array of
   { ticker, strike, expiry, type, qty, id }. Returns an array of the SAME
   length/order: { lastPrice, delta, theta, gamma, vega, beta, earningsDate }
   or { error } when no underlying price is available for that leg. */
router.post('/market/options-prices', async (req, res) => {
  try {
    const reqs = Array.isArray(req.body) ? req.body : [];
    if (!reqs.length) return res.json([]);

    // One spot + vol fetch per unique ticker for the whole batch.
    const tickers = [...new Set(reqs.map((r) => String(r.ticker || '').toUpperCase()).filter(Boolean))];
    const ctx = {};
    await mapLimit(tickers, 3, async (t) => {
      const [spot, vol] = await Promise.all([quotes.getSpot(t), quotes.getRealizedVol(t)]);
      ctx[t] = { spot, vol: vol || DEFAULT_IV, beta: betaFor(t) };
    });

    const out = reqs.map((r) => {
      const t = String(r.ticker || '').toUpperCase();
      const c = ctx[t];
      if (!c || c.spot == null) return { error: 'no underlying price' };
      const greeks = priceOption(c.spot, r.strike, r.expiry, r.type, c.vol, RISK_FREE_RATE);
      if (!greeks) return { error: 'unpriceable' };
      return {
        lastPrice: greeks.price,
        delta: greeks.delta,
        theta: greeks.theta,
        gamma: greeks.gamma,
        vega: greeks.vega,
        beta: c.beta,
        earningsDate: null,
        underlying: c.spot,
        iv: Math.round(c.vol * 1000) / 1000,
      };
    });
    res.json(out);
  } catch (e) {
    console.error('[market] options-prices failed:', e.message);
    res.json([]);
  }
});

/* GET /market/vix-history — [{ date, close }] (most-recent last). */
router.get('/market/vix-history', async (req, res) => {
  try {
    const hist = await quotes.getVixHistory();
    res.json(Array.isArray(hist) ? hist : []);
  } catch (e) {
    res.json([]);
  }
});

/* GET /fred/:id — [{ date, value }]. Used for the VIX 3M term-structure read. */
router.get('/fred/:id', async (req, res) => {
  try {
    const series = await quotes.getFredSeries(req.params.id);
    res.json(Array.isArray(series) ? series : []);
  } catch (e) {
    res.json([]);
  }
});

/* GET /catalysts-batch — no free earnings-calendar source without a key; the
   page treats {} as "no catalyst data" and degrades cleanly. */
router.get('/catalysts-batch', (req, res) => {
  res.json({});
});

/* GET /portfolio-risk-data — per-ticker sector/industry/beta so the page can
   render its Sector & Industry Exposure breakdown. dailyReturns is left empty
   (no free intraday history feed for a full correlation matrix); the page's
   correlation panel degrades to "unavailable" on its own. */
router.get('/portfolio-risk-data', (req, res) => {
  try {
    const tickers = String(req.query.tickers || '')
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    if (!tickers.length) return res.json({});
    const out = {};
    const stmt = db.prepare('SELECT company_name, beta, sector, industry FROM stocks WHERE symbol = ?');
    for (const t of [...new Set(tickers)]) {
      const row = stmt.get(t);
      out[t] = {
        sector: (row && row.sector) || 'Other / Unclassified',
        industry: (row && row.industry) || 'Unclassified',
        beta: row && row.beta != null ? Number(row.beta) : null,
        dailyReturns: [],
      };
    }
    res.json(out);
  } catch (e) {
    console.error('[market] portfolio-risk-data failed:', e.message);
    res.json({});
  }
});

/* GET /stock/:ticker — minimal stock detail for the page's per-name links. */
router.get('/stock/:ticker', async (req, res) => {
  try {
    const t = String(req.params.ticker || '').toUpperCase();
    const price = await quotes.getSpot(t);
    let company_name = t;
    try {
      const row = db.prepare('SELECT company_name FROM stocks WHERE symbol = ?').get(t);
      if (row && row.company_name) company_name = row.company_name;
    } catch (e) {
      /* no stocks row */
    }
    res.json({ ticker: t, price: price != null ? price : null, company_name, beta: betaFor(t) });
  } catch (e) {
    res.json({ ticker: String(req.params.ticker || '').toUpperCase(), price: null });
  }
});

module.exports = router;
