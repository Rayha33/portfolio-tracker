/*
 * misc.js — small endpoints the two pages touch besides positions/track/market.
 *
 * Note: there is intentionally NO /api/tradestation/* router. The portfolio page
 * keeps its "TradeStation Live" panel hidden when that route 404s, which is
 * exactly what we want in a self-hosted, broker-less build — positions are
 * entered manually / via CSV instead.
 */
const { Router } = require('express');
const db = require('../lib/db');
const { authRequired, LOCAL_USER } = require('../lib/auth');

const router = Router();

/* Identity for any UI that asks who is logged in. Always the local user. */
router.get('/auth/me', (req, res) => {
  res.json({ user: LOCAL_USER });
});

/* No real sessions to end — acknowledge so logout UIs don't error. */
router.post('/auth/logout', (req, res) => {
  res.json({ ok: true });
});

/* Earnings overlay on the Realized page. No free keyless source, so return an
   empty list — the page treats that as "no earnings markers" and renders fine. */
router.get('/earnings-calendar', (req, res) => {
  res.json([]);
});

/* CSV export of the current open book (used by the page's download action). */
router.get('/export/trade-monitor', authRequired, (req, res) => {
  try {
    const rows = db
      .prepare("SELECT * FROM positions WHERE user_id = ? AND status = 'open' ORDER BY ticker")
      .all(LOCAL_USER.id);
    const header = ['Ticker', 'Direction', 'Structure', 'Entry Date', 'Leg', 'Type', 'Strike', 'Expiry', 'Qty', 'Premium'];
    const lines = [header.join(',')];
    for (const r of rows) {
      let legs = [];
      try {
        legs = JSON.parse(r.legs_json || '[]');
      } catch (e) {
        legs = [];
      }
      legs.forEach((leg, i) => {
        lines.push(
          [
            r.ticker,
            r.direction,
            csv(r.structure),
            r.entry_date,
            i + 1,
            leg.option_type || leg.type || '',
            leg.strike ?? '',
            leg.expiration || '',
            leg.size ?? '',
            leg.premium ?? '',
          ].join(',')
        );
      });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="portfolio.csv"');
    res.send(lines.join('\n'));
  } catch (e) {
    console.error('[misc] export failed:', e.message);
    res.status(500).json({ error: 'Export failed' });
  }
});

function csv(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = router;
