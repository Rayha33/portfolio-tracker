/*
 * seed.js — synthetic demo data.
 *
 * Generates a realistic-but-fictional options book so a fresh clone is fully
 * functional out of the box: open positions (with mark-to-market P&L), a set of
 * closed trades (the Realized table), a matching track record (equity curve +
 * win rate), company names, and a first-paint quote cache.
 *
 * NONE of this is real trading data. Replace it with your own positions via the
 * UI (or wipe and re-seed with `npm run reseed`).
 *
 * Usage:
 *   node db/seed.js            # seed only if empty
 *   node db/seed.js --force    # wipe portfolio tables and re-seed
 */
const fs = require('fs');
const path = require('path');

// ── Company universe (name, beta, sector, industry) used across the demo book ──
const UNIVERSE = {
  AAPL: { name: 'Apple Inc.', beta: 1.21, sector: 'Technology', industry: 'Consumer Electronics' },
  MSFT: { name: 'Microsoft Corp.', beta: 1.08, sector: 'Technology', industry: 'Software — Infrastructure' },
  NVDA: { name: 'NVIDIA Corp.', beta: 1.72, sector: 'Technology', industry: 'Semiconductors' },
  AMD: { name: 'Advanced Micro Devices', beta: 1.95, sector: 'Technology', industry: 'Semiconductors' },
  GOOGL: { name: 'Alphabet Inc.', beta: 1.06, sector: 'Communication Services', industry: 'Internet Content' },
  AMZN: { name: 'Amazon.com Inc.', beta: 1.31, sector: 'Consumer Discretionary', industry: 'Internet Retail' },
  META: { name: 'Meta Platforms Inc.', beta: 1.34, sector: 'Communication Services', industry: 'Internet Content' },
  TSLA: { name: 'Tesla Inc.', beta: 2.04, sector: 'Consumer Discretionary', industry: 'Auto Manufacturers' },
  CRM: { name: 'Salesforce Inc.', beta: 1.28, sector: 'Technology', industry: 'Software — Application' },
  NFLX: { name: 'Netflix Inc.', beta: 1.27, sector: 'Communication Services', industry: 'Entertainment' },
  UBER: { name: 'Uber Technologies', beta: 1.42, sector: 'Technology', industry: 'Software — Application' },
  SHOP: { name: 'Shopify Inc.', beta: 2.11, sector: 'Technology', industry: 'Software — Application' },
  COIN: { name: 'Coinbase Global', beta: 2.6, sector: 'Financials', industry: 'Capital Markets' },
  PLTR: { name: 'Palantir Technologies', beta: 2.3, sector: 'Technology', industry: 'Software — Infrastructure' },
  DIS: { name: 'Walt Disney Co.', beta: 1.18, sector: 'Communication Services', industry: 'Entertainment' },
  BA: { name: 'Boeing Co.', beta: 1.45, sector: 'Industrials', industry: 'Aerospace & Defense' },
};

function occSymbol(ticker, expiry, type, strike) {
  const d = String(expiry).slice(2, 10).replace(/-/g, ''); // YYMMDD
  const c = type.toLowerCase().startsWith('p') ? 'P' : 'C';
  const k = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${ticker} ${d}${c}${k}`;
}

function leg(direction, type, expiry, strike, size, premium, extra = {}) {
  return Object.assign(
    {
      direction,
      option_type: type,
      type,
      expiration: expiry,
      strike,
      size,
      premium,
      mult: 100,
      symbol: occSymbol(extra.ticker || '', expiry, type, strike),
    },
    (() => {
      const e = Object.assign({}, extra);
      delete e.ticker;
      return e;
    })()
  );
}

function netDebit(legs) {
  return legs.reduce((s, l) => s + (l.direction === 'short' ? -1 : 1) * l.premium * l.size * (l.mult || 100), 0);
}

// ── OPEN positions ────────────────────────────────────────────────────────────
// `mark` on each leg is the current per-share option price used for first-paint
// P&L (also written to the quote cache below). Live refresh overwrites it.
function openBook() {
  return [
    {
      ticker: 'AAPL',
      structure: 'Bull Call Spread',
      direction: 'long',
      entry_date: '2026-04-14',
      p1: 215,
      p2: 235,
      notes: 'Services momentum + buyback; defined-risk call spread.',
      legs: [
        leg('long', 'call', '2026-09-18', 200, 6, 12.4, { ticker: 'AAPL', mark: 16.1 }),
        leg('short', 'call', '2026-09-18', 230, 6, 4.1, { ticker: 'AAPL', mark: 5.4 }),
      ],
    },
    {
      ticker: 'MSFT',
      structure: 'Long Call',
      direction: 'long',
      entry_date: '2026-05-02',
      p1: 520,
      p2: 560,
      notes: 'Azure AI re-acceleration into FY print.',
      legs: [leg('long', 'call', '2026-10-16', 480, 4, 24.5, { ticker: 'MSFT', mark: 29.8 })],
    },
    {
      ticker: 'NVDA',
      structure: 'Bull Call Spread',
      direction: 'long',
      entry_date: '2026-05-20',
      p1: 175,
      p2: 200,
      notes: 'Data-center demand; spread caps premium outlay.',
      legs: [
        leg('long', 'call', '2026-11-20', 150, 10, 18.2, { ticker: 'NVDA', mark: 21.0 }),
        leg('short', 'call', '2026-11-20', 190, 10, 7.4, { ticker: 'NVDA', mark: 8.9 }),
      ],
    },
    {
      ticker: 'AMD',
      structure: 'Long Call',
      direction: 'long',
      entry_date: '2026-06-01',
      p1: 200,
      p2: 230,
      notes: 'MI-series ramp; high IV, sized small.',
      legs: [leg('long', 'call', '2026-12-18', 175, 6, 19.7, { ticker: 'AMD', mark: 17.2 })],
    },
    {
      ticker: 'GOOGL',
      structure: 'Bull Call Spread',
      direction: 'long',
      entry_date: '2026-04-28',
      p1: 215,
      p2: 240,
      notes: 'Cloud margin inflection + Gemini monetization.',
      legs: [
        leg('long', 'call', '2026-09-18', 190, 8, 13.1, { ticker: 'GOOGL', mark: 17.5 }),
        leg('short', 'call', '2026-09-18', 220, 8, 5.2, { ticker: 'GOOGL', mark: 7.1 }),
      ],
    },
    {
      ticker: 'META',
      structure: 'Call Calendar',
      direction: 'long',
      entry_date: '2026-05-12',
      p1: 760,
      p2: 820,
      notes: 'Calendar: sell near, own back-month into Reality Labs catalyst.',
      legs: [
        leg('long', 'call', '2026-12-18', 720, 3, 41.0, { ticker: 'META', mark: 46.5 }),
        leg('short', 'call', '2026-08-21', 720, 3, 18.5, { ticker: 'META', mark: 16.2 }),
      ],
    },
    {
      ticker: 'TSLA',
      structure: 'Long Put',
      direction: 'short',
      entry_date: '2026-06-03',
      p1: 280,
      p2: 240,
      notes: 'Bearish: deliveries decel + margin pressure. Long premium.',
      legs: [leg('long', 'put', '2026-10-16', 300, 5, 27.0, { ticker: 'TSLA', mark: 30.6 })],
    },
    {
      ticker: 'UBER',
      structure: 'Long Call',
      direction: 'long',
      entry_date: '2026-05-27',
      p1: 105,
      p2: 120,
      notes: 'Mobility + delivery take-rate; FCF inflection.',
      legs: [leg('long', 'call', '2026-11-20', 90, 8, 9.8, { ticker: 'UBER', mark: 11.4 })],
    },
  ];
}

// ── CLOSED trades (the Realized table + equity curve) ────────────────────────
// Each carries an exit_premium per leg; realized P&L derives from it.
function closedBook() {
  return [
    mkClosed('NFLX', 'Long Call', 'long', '2026-01-08', '2026-02-19', [['long', 'call', '2026-03-20', 600, 4, 32.0, 58.5]], 78, 'AI recommendation re-rate; trimmed into strength.'),
    mkClosed('CRM', 'Bull Call Spread', 'long', '2026-01-15', '2026-03-05', [['long', 'call', '2026-04-17', 300, 6, 14.2, 22.8], ['short', 'call', '2026-04-17', 340, 6, 5.1, 8.9]], 72, 'Agentforce attach; spread hit target.'),
    mkClosed('PLTR', 'Long Call', 'long', '2026-02-02', '2026-03-18', [['long', 'call', '2026-05-15', 90, 10, 8.5, 14.2]], 70, 'Commercial bookings beat.'),
    mkClosed('DIS', 'Long Call', 'long', '2026-01-22', '2026-03-10', [['long', 'call', '2026-04-17', 110, 8, 6.4, 3.1]], 52, 'Streaming guide-down; cut the loss.'),
    mkClosed('BA', 'Long Put', 'short', '2026-02-10', '2026-04-01', [['long', 'put', '2026-05-15', 200, 5, 11.0, 18.7]], 68, 'Quality headlines; bearish put worked.'),
    mkClosed('SHOP', 'Bull Call Spread', 'long', '2026-02-18', '2026-04-09', [['long', 'call', '2026-06-19', 120, 7, 11.8, 7.4], ['short', 'call', '2026-06-19', 150, 7, 4.6, 2.9]], 48, 'Take-rate disappointment; spread loss.'),
    mkClosed('COIN', 'Long Call', 'long', '2026-03-02', '2026-04-22', [['long', 'call', '2026-06-19', 260, 4, 28.0, 47.5]], 80, 'Crypto beta + spot ETF flows.'),
    mkClosed('AMZN', 'Bull Call Spread', 'long', '2026-03-12', '2026-05-07', [['long', 'call', '2026-06-19', 200, 6, 12.0, 19.6], ['short', 'call', '2026-06-19', 230, 6, 4.3, 7.8]], 74, 'AWS reaccel; clean spread win.'),
    mkClosed('AMD', 'Long Call', 'long', '2026-03-20', '2026-05-14', [['long', 'call', '2026-06-19', 160, 6, 15.5, 9.2]], 50, 'Datacenter air-pocket; trimmed.'),
    mkClosed('NVDA', 'Long Call', 'long', '2026-04-01', '2026-05-28', [['long', 'call', '2026-07-17', 130, 8, 16.0, 27.4]], 82, 'Blackwell ramp; let it run, then booked.'),
    mkClosed('GOOGL', 'Long Call', 'long', '2026-02-26', '2026-04-15', [['long', 'call', '2026-05-15', 180, 6, 10.5, 16.9]], 71, 'Search resilience + cloud margin.'),
    mkClosed('META', 'Bull Call Spread', 'long', '2026-01-29', '2026-03-21', [['long', 'call', '2026-04-17', 680, 3, 28.0, 41.5], ['short', 'call', '2026-04-17', 740, 3, 11.0, 18.0]], 69, 'Ad pricing power; spread to target.'),
  ];
}

function mkClosed(ticker, structure, direction, entry, closed, legSpecs, verdict, notes) {
  const legs = legSpecs.map(([dir, type, exp, strike, size, premium, exit]) =>
    leg(dir, type, exp, strike, size, premium, { ticker, exit_premium: exit, mark: exit })
  );
  return { ticker, structure, direction, entry_date: entry, closed_date: closed, legs, verdict, notes };
}

function realizedPnl(legs) {
  return legs.reduce((sum, l) => {
    const entry = Number(l.premium || 0);
    const exit = l.exit_premium != null ? Number(l.exit_premium) : 0;
    const size = Number(l.size || 0);
    const mult = Number(l.mult || 100);
    return sum + (l.direction === 'short' ? entry - exit : exit - entry) * size * mult;
  }, 0);
}

const USER_ID = '1';

function seed(db, { force = false } = {}) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM positions').get().c;
  if (count > 0 && !force) return { seeded: false };

  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM positions').run();
    db.prepare('DELETE FROM track_record').run();
    db.prepare('DELETE FROM position_quote_cache').run();
    db.prepare('DELETE FROM stocks').run();
  });
  wipe();

  const insStock = db.prepare('INSERT OR REPLACE INTO stocks (symbol, company_name, beta, sector, industry) VALUES (?, ?, ?, ?, ?)');
  for (const [sym, info] of Object.entries(UNIVERSE)) insStock.run(sym, info.name, info.beta, info.sector || null, info.industry || null);

  const insPos = db.prepare(`
    INSERT INTO positions
      (ticker, direction, structure, legs_json, entry_date, net_debit, p1_target, p2_target,
       status, closed_date, notes, source_idea, user_id, created_at, updated_at)
    VALUES (@ticker, @direction, @structure, @legs_json, @entry_date, @net_debit, @p1_target, @p2_target,
            @status, @closed_date, @notes, @source_idea, @user_id, datetime('now'), datetime('now'))
  `);

  const insQuote = db.prepare(`
    INSERT OR REPLACE INTO position_quote_cache
      (cache_key, ticker, last_price, delta, theta, gamma, vega, beta, earnings_date, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insTrack = db.prepare(`
    INSERT OR IGNORE INTO track_record
      (trade_id, ticker, direction, rating, entry_price, option_structure, option_expiry,
       entry_premium, verdict_score, entry_date, status, resolved_date, resolved_price,
       stock_return_pct, direction_correct, win, shares, realized_pnl, backfilled)
    VALUES (@trade_id, @ticker, @direction, @rating, @entry_price, @option_structure, @option_expiry,
            @entry_premium, @verdict_score, @entry_date, 'resolved', @resolved_date, @resolved_price,
            @stock_return_pct, @direction_correct, @win, @shares, @realized_pnl, 0)
  `);

  const tx = db.transaction(() => {
    // Open positions + first-paint quote cache.
    for (const p of openBook()) {
      const legs = p.legs.map((l) => {
        const { mark, ...rest } = l;
        return rest;
      });
      insPos.run({
        ticker: p.ticker,
        direction: p.direction,
        structure: p.structure,
        legs_json: JSON.stringify(legs),
        entry_date: p.entry_date,
        net_debit: Math.round(netDebit(legs) * 100) / 100,
        p1_target: p.p1 ?? null,
        p2_target: p.p2 ?? null,
        status: 'open',
        closed_date: null,
        notes: p.notes || null,
        source_idea: 'demo',
        user_id: USER_ID,
      });
      // Seed a current mark per leg so P&L shows even fully offline.
      p.legs.forEach((l) => {
        if (l.mark == null) return;
        const key = `${p.ticker.toUpperCase()}|${l.strike}|${String(l.expiration).slice(0, 10)}|${l.type}`;
        insQuote.run(key, p.ticker.toUpperCase(), l.mark, null, null, null, null, UNIVERSE[p.ticker]?.beta ?? null, null);
      });
    }

    // Closed positions (Realized table) + matching track record (equity curve).
    let i = 0;
    for (const c of closedBook()) {
      i++;
      const legs = c.legs.map((l) => {
        const { mark, ...rest } = l;
        return rest;
      });
      insPos.run({
        ticker: c.ticker,
        direction: c.direction,
        structure: c.structure,
        legs_json: JSON.stringify(legs),
        entry_date: c.entry_date,
        net_debit: Math.round(netDebit(legs) * 100) / 100,
        p1_target: null,
        p2_target: null,
        status: 'closed',
        closed_date: c.closed_date,
        notes: c.notes || null,
        source_idea: 'demo',
        user_id: USER_ID,
      });

      const primary = legs.find((l) => l.direction === 'long') || legs[0];
      const pnl = Math.round(realizedPnl(legs) * 100) / 100;
      const shares = Number(primary.size) * Number(primary.mult || 100);
      const entryPrem = Number(primary.premium);
      const win = pnl >= 0 ? 1 : 0;
      const ret = entryPrem && shares ? (pnl / Math.abs(entryPrem * shares)) * 100 : null;
      const dirLabel = c.direction === 'short' ? 'SHORT' : 'LONG';
      const optLabel = `${primary.direction === 'short' ? 'Short' : 'Long'} ${primary.type === 'put' ? 'Put' : 'Call'} $${primary.strike}`;
      insTrack.run({
        trade_id: `seed-${c.ticker}-${i}`,
        ticker: c.ticker,
        direction: dirLabel,
        rating: dirLabel,
        entry_price: entryPrem,
        option_structure: optLabel,
        option_expiry: primary.expiration,
        entry_premium: entryPrem,
        verdict_score: c.verdict ?? null,
        entry_date: c.entry_date,
        resolved_date: c.closed_date,
        resolved_price: primary.exit_premium ?? null,
        stock_return_pct: ret != null ? Math.round(ret * 100) / 100 : null,
        direction_correct: win,
        win,
        shares,
        realized_pnl: pnl,
      });
    }
  });
  tx();

  writeLatestPositionsFile(db);
  return { seeded: true };
}

// Regenerate public/data/latest-positions.js (a client-side fallback the page
// reads before the live hydrate). Built from the demo open book so it never
// contains anything but demo data.
function writeLatestPositionsFile(db) {
  try {
    const rows = db.prepare("SELECT * FROM positions WHERE status='open' ORDER BY ticker").all();
    const positions = [];
    for (const r of rows) {
      let legs = [];
      try {
        legs = JSON.parse(r.legs_json || '[]');
      } catch (e) {
        legs = [];
      }
      const primary = legs.find((l) => l.direction === 'long') || legs[0] || {};
      positions.push({
        id: `demo_${r.id}`,
        ticker: r.ticker,
        type: `${primary.direction === 'short' ? 'Short' : 'Long'} ${primary.type === 'put' ? 'Put' : 'Call'}`,
        strike: primary.strike ?? null,
        strikeSell: (legs.find((l) => l.direction === 'short') || {}).strike ?? null,
        expiry: primary.expiration ?? null,
        qty: primary.size ?? null,
        entry: primary.premium ?? null,
        current: primary.premium ?? null,
        entryDate: r.entry_date,
        status: 'open',
        notes: 'Demo position',
      });
    }
    const body =
      "window.LATEST_PORTFOLIO_VERSION = 'demo-seed';\n" +
      'window.LATEST_PORTFOLIO_EQUITY = 100000;\n' +
      'window.LATEST_PORTFOLIO_POSITIONS = ' +
      JSON.stringify(positions, null, 2) +
      ';\n';
    const out = path.join(__dirname, '..', 'public', 'data', 'latest-positions.js');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
  } catch (e) {
    console.warn('[seed] could not write latest-positions.js:', e.message);
  }
}

function ensureSeeded(db) {
  const res = seed(db, { force: false });
  if (res.seeded) console.log('[seed] demo portfolio created.');
  return res;
}

module.exports = { seed, ensureSeeded };

// CLI
if (require.main === module) {
  const db = require('../lib/db');
  const force = process.argv.includes('--force');
  const res = seed(db, { force });
  console.log(res.seeded ? `[seed] done (force=${force}).` : '[seed] skipped — positions already exist (use --force to wipe & reseed).');
}
