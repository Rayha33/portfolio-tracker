const { Router } = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const { authRequired } = require('../lib/auth');
const { portfolioUserId } = require('../lib/portfolio-config');
const { TTLCache, etagJson } = require('../lib/response-cache');

const router = Router();

/* The aggregate /public stats only change when a trade is added/resolved, so a
   short shared TTL cache + ETag removes per-request DB/JS work. */
const publicStatsCache = new TTLCache({ ttlMs: 120 * 1000, max: 1 });

function parseLegs(row) {
  try {
    const legs = typeof row.legs_json === 'string' ? JSON.parse(row.legs_json) : row.legs_json;
    return Array.isArray(legs) ? legs : [];
  } catch (e) {
    return [];
  }
}

function optionType(leg, structure) {
  const raw = String((leg && (leg.option_type || leg.type)) || structure || '').toLowerCase();
  if (raw.includes('put')) return 'Put';
  if (raw.includes('call')) return 'Call';
  return 'Option';
}

/* Map a closed position row → the Realized table's trade shape. Realized P&L is
   summed across legs by long/short sign. A 'closed' position whose legs carry no
   exit data gets NULL realized values (not a fabricated full loss); only expired
   positions are treated as exit=0 (expired worthless). */
function positionToTrackRecord(row) {
  const legs = parseLegs(row);
  const primary = legs.find((l) => String((l && l.direction) || '').toLowerCase() === 'long') || legs[0] || {};
  const qty = Number(primary.size || 0);
  const shares = qty * Number(primary.mult || 100);
  const entryPremium = primary.premium != null ? Number(primary.premium) : null;
  const exitPremium = primary.exit_premium != null ? Number(primary.exit_premium) : null;
  const legDir = String(primary.direction || row.direction || '').toLowerCase() === 'short' ? 'SHORT' : 'LONG';
  const legType = optionType(primary, row.structure);
  const strike = primary.strike != null ? Number(primary.strike) : null;
  const isExpired = String(row.status || '').toLowerCase() === 'expired';
  let missingExit = false;
  const realizedPnl = legs.reduce((sum, leg) => {
    const dir = String((leg && leg.direction) || '').toLowerCase();
    const size = Number((leg && leg.size) || 0);
    const mult = Number((leg && leg.mult) || 100);
    if (!size) return sum;
    const entry = Number((leg && leg.premium) || 0);
    let exit;
    if (leg && leg.exit_premium != null) exit = Number(leg.exit_premium);
    else if (isExpired) exit = 0;
    else {
      missingExit = true;
      exit = 0;
    }
    return sum + (dir === 'short' ? entry - exit : exit - entry) * size * mult;
  }, 0);
  const hasRealized = !missingExit;
  const stockReturnPct = hasRealized && entryPremium && shares ? (realizedPnl / Math.abs(entryPremium * shares)) * 100 : null;

  return {
    trade_id: `pos-${row.id}`,
    ticker: row.ticker,
    direction: legDir,
    rating: legDir,
    entry_price: entryPremium || 0,
    price_target: null,
    catalyst: null,
    catalyst_date: null,
    option_structure: `${legDir === 'SHORT' ? 'Short' : 'Long'} ${legType}${strike != null ? ' $' + strike : ''}`,
    option_expiry: primary.expiration || null,
    entry_premium: entryPremium,
    verdict_score: null,
    macro_factor: null,
    kpi_momentum: null,
    entry_date: row.entry_date,
    status: 'resolved',
    current_price: null,
    resolved_date: row.closed_date,
    resolved_price: exitPremium,
    stock_return_pct: stockReturnPct,
    direction_correct: hasRealized ? (realizedPnl >= 0 ? 1 : 0) : null,
    win: hasRealized ? (realizedPnl >= 0 ? 1 : 0) : null,
    shares: shares || 100,
    realized_pnl: hasRealized ? Math.round(realizedPnl * 100) / 100 : null,
    notes: row.notes,
    source_idea: row.source_idea,
  };
}

/* ── GET /track-record/public — aggregate stats + equity curve, no auth ── */
router.get('/track-record/public', (req, res) => {
  try {
    const cachedStats = publicStatsCache.get('public');
    if (cachedStats) {
      return etagJson(req, res, cachedStats, { maxAge: 120, isPrivate: false, staleWhileRevalidate: 120 });
    }

    const total = db.prepare('SELECT COUNT(*) as count FROM track_record').get();
    const dateRange = db.prepare('SELECT MIN(entry_date) as from_date, MAX(entry_date) as to_date FROM track_record').get();
    const resolved = db.prepare("SELECT COUNT(*) as count FROM track_record WHERE status = 'resolved'").get();
    const active = db.prepare("SELECT COUNT(*) as count FROM track_record WHERE status IN ('pending', 'active')").get();

    const winStats = db
      .prepare(
        `
      SELECT COUNT(*) as total,
             SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) as wins,
             AVG(stock_return_pct) as avg_return
      FROM track_record
      WHERE status = 'resolved' AND rating != 'NEUTRAL'
    `
      )
      .get();

    const avgWinners = db.prepare("SELECT AVG(verdict_score) as avg FROM track_record WHERE win = 1 AND status = 'resolved'").get();
    const avgLosers = db.prepare("SELECT AVG(verdict_score) as avg FROM track_record WHERE win = 0 AND status = 'resolved' AND rating != 'NEUTRAL'").get();

    const byRating = db
      .prepare(
        `
      SELECT rating, COUNT(*) as count,
             SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) as wins,
             AVG(stock_return_pct) as avg_return
      FROM track_record
      WHERE status = 'resolved' AND rating != 'NEUTRAL'
      GROUP BY rating
    `
      )
      .all();

    const curveData = db
      .prepare(
        `
      SELECT resolved_date, entry_price, resolved_price, shares, entry_premium, direction, option_structure, realized_pnl
      FROM track_record
      WHERE status = 'resolved' AND resolved_date IS NOT NULL
      ORDER BY resolved_date
    `
      )
      .all();

    const startingCapital = Number(process.env.STARTING_CAPITAL) || 20000;

    let cumPnl = 0;
    const equityCurve = [{ date: dateRange.from_date || new Date().toISOString().slice(0, 10), value: Math.round(startingCapital) }];
    for (const row of curveData) {
      let pnl;
      if (row.realized_pnl != null && Number.isFinite(Number(row.realized_pnl))) {
        pnl = Number(row.realized_pnl);
      } else if (row.resolved_price == null) {
        continue;
      } else {
        const shares = row.shares || 100;
        const entryCost = (row.entry_premium || row.entry_price || 0) * shares;
        const exitValue = (row.resolved_price || 0) * shares;
        const opt = (row.option_structure || '').toLowerCase();
        const soldToOpen = opt ? opt.startsWith('short ') : String(row.direction || '').toUpperCase() === 'SHORT';
        pnl = soldToOpen ? entryCost - exitValue : exitValue - entryCost;
      }
      cumPnl += pnl;
      equityCurve.push({ date: row.resolved_date, value: Math.round((startingCapital + cumPnl) * 100) / 100 });
    }

    const stats = {
      total_ideas: total.count,
      date_range: { from: dateRange.from_date, to: dateRange.to_date },
      resolved_ideas: resolved.count,
      active_ideas: active.count,
      overall_win_rate: winStats.total > 0 ? Math.round((winStats.wins / winStats.total) * 10000) / 100 : null,
      avg_stock_return_pct: winStats.avg_return != null ? Math.round(winStats.avg_return * 100) / 100 : null,
      avg_verdict_score_winners: avgWinners.avg != null ? Math.round(avgWinners.avg * 10) / 10 : null,
      avg_verdict_score_losers: avgLosers.avg != null ? Math.round(avgLosers.avg * 10) / 10 : null,
      by_rating: byRating.reduce((acc, r) => {
        acc[r.rating] = {
          count: r.count,
          win_rate: r.count > 0 ? Math.round((r.wins / r.count) * 10000) / 100 : null,
          avg_return: r.avg_return != null ? Math.round(r.avg_return * 100) / 100 : null,
        };
        return acc;
      }, {}),
      by_regime: {},
      equity_curve: equityCurve,
      latest_audit_hash: null,
      audit_log_url: null,
    };

    publicStatsCache.set('public', stats);
    return etagJson(req, res, stats, { maxAge: 120, isPrivate: false, staleWhileRevalidate: 120 });
  } catch (err) {
    console.error('[track-record]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ── GET /track-record/member — the Realized per-trade table. Derived from
   closed/expired positions (same source-of-truth as the close flow). ── */
router.get('/track-record/member', authRequired, (req, res) => {
  try {
    const requestedStatus = String(req.query.status || '').toLowerCase();
    if (!requestedStatus || requestedStatus === 'resolved' || requestedStatus === 'closed') {
      const userId = portfolioUserId(req.user);
      const rows = db
        .prepare(
          `
        SELECT id, ticker, direction, structure, legs_json, entry_date, net_debit,
               p1_target, p2_target, status, closed_date, notes, source_idea,
               user_id, created_at, updated_at
        FROM positions
        WHERE user_id = ? AND status IN ('closed', 'expired')
        ORDER BY closed_date DESC, entry_date DESC, id DESC
      `
        )
        .all(userId);
      const trades = rows.map(positionToTrackRecord);
      attachCompanyNames(trades);
      return res.json(trades);
    }

    let sql = 'SELECT * FROM track_record WHERE 1=1';
    const params = [];
    if (req.query.direction) {
      sql += ' AND direction = ?';
      params.push(req.query.direction);
    }
    if (req.query.rating) {
      sql += ' AND rating = ?';
      params.push(req.query.rating);
    }
    if (req.query.status) {
      sql += ' AND status = ?';
      params.push(req.query.status);
    }
    if (req.query.from) {
      sql += ' AND entry_date >= ?';
      params.push(req.query.from);
    }
    if (req.query.to) {
      sql += ' AND entry_date <= ?';
      params.push(req.query.to);
    }
    sql += ' ORDER BY entry_date DESC';
    const trades = db.prepare(sql).all(...params);
    attachCompanyNames(trades);
    res.json(trades);
  } catch (err) {
    console.error('[track-record]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* Batch company-name lookup from the local stocks table (best-effort). */
function attachCompanyNames(trades) {
  if (!trades.length) return;
  try {
    const tickers = [...new Set(trades.map((t) => t.ticker))];
    const placeholders = tickers.map(() => '?').join(',');
    const rows = db.prepare(`SELECT symbol, company_name FROM stocks WHERE symbol IN (${placeholders})`).all(...tickers);
    const nameMap = {};
    rows.forEach((r) => {
      nameMap[r.symbol] = r.company_name;
    });
    trades.forEach((t) => {
      t.company_name = nameMap[t.ticker] || t.ticker;
    });
  } catch (e) {
    /* stocks table empty / missing — fall back to ticker */
    trades.forEach((t) => {
      t.company_name = t.company_name || t.ticker;
    });
  }
}

/* == POST /track-record/update-field — inline edit a single whitelisted field == */
router.post('/track-record/update-field', authRequired, (req, res) => {
  try {
    const { trade_id, field, value } = req.body;
    if (!trade_id || !field) return res.status(400).json({ error: 'trade_id and field required' });
    if (value === undefined) return res.status(400).json({ error: 'value required' });
    const FIELD_SQL = Object.create(null);
    FIELD_SQL.entry_date = 'entry_date';
    FIELD_SQL.resolved_date = 'resolved_date';
    FIELD_SQL.entry_price = 'entry_price';
    FIELD_SQL.resolved_price = 'resolved_price';
    FIELD_SQL.price_target = 'price_target';
    FIELD_SQL.catalyst_date = 'catalyst_date';
    FIELD_SQL.option_expiry = 'option_expiry';
    FIELD_SQL.shares = 'shares';
    const col = FIELD_SQL[field];
    if (!col) return res.status(400).json({ error: 'Field not editable: ' + field });
    const info = db.prepare(`UPDATE track_record SET ${col} = ?, updated_at = datetime('now') WHERE trade_id = ?`).run(value, trade_id);
    if (info.changes === 0) return res.status(404).json({ error: 'Trade not found in track record: ' + trade_id });
    publicStatsCache.clear();
    res.json({ ok: true });
  } catch (err) {
    console.error('[track-record]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* == POST /track-record/add — insert a new closed trade == */
router.post('/track-record/add', authRequired, (req, res) => {
  try {
    const t = req.body;
    if (!t.ticker || !t.direction) return res.status(400).json({ error: 'ticker and direction required' });
    if (!t.resolved_date) return res.json({ ok: true, skipped: true, reason: 'no exit date' });

    const existing = db
      .prepare(`SELECT trade_id FROM track_record WHERE ticker = ? AND entry_date = ? AND resolved_date = ? AND direction = ? LIMIT 1`)
      .get(t.ticker, t.entry_date || null, t.resolved_date || null, t.direction || 'LONG');
    if (existing) return res.json({ ok: true, trade_id: existing.trade_id, skipped: true });

    const hashInput = JSON.stringify({
      ticker: t.ticker,
      direction: t.direction,
      entry_price: t.entry_price,
      entry_date: t.entry_date,
      resolved_date: t.resolved_date || null,
      option_structure: t.option_structure || null,
      shares: t.shares || 100,
    });
    const trade_id = t.trade_id || t.ticker + '_' + crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 12);
    const entry_hash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

    db.prepare(
      `INSERT OR IGNORE INTO track_record (
      trade_id, ticker, direction, rating, entry_price, price_target,
      catalyst, catalyst_date, option_structure, option_expiry, entry_premium,
      verdict_score, macro_factor, kpi_momentum, entry_date, status, backfilled,
      entry_hash, current_price, resolved_date, resolved_price, stock_return_pct,
      win, shares, realized_pnl, price_basis
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      trade_id,
      t.ticker,
      t.direction || 'LONG',
      t.rating || t.direction || 'LONG',
      t.entry_price || 0,
      t.price_target || null,
      t.catalyst || null,
      t.catalyst_date || null,
      t.option_structure || null,
      t.option_expiry || null,
      t.entry_premium || null,
      t.verdict_score || null,
      t.macro_factor || null,
      t.kpi_momentum || null,
      t.entry_date || new Date().toISOString().slice(0, 10),
      t.status || 'resolved',
      entry_hash,
      t.current_price || null,
      t.resolved_date || null,
      t.resolved_price != null ? t.resolved_price : null,
      t.stock_return_pct != null ? t.stock_return_pct : null,
      t.win != null ? t.win : null,
      t.shares || 100,
      t.realized_pnl != null ? t.realized_pnl : null,
      ['per_contract_dollars', 'per_share', 'total'].includes(t.price_basis) ? t.price_basis : null
    );
    publicStatsCache.clear();
    res.json({ ok: true, trade_id });
  } catch (err) {
    console.error('[track-record]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* == POST /track-record/delete — remove a trade == */
router.post('/track-record/delete', authRequired, (req, res) => {
  try {
    const { trade_id } = req.body;
    if (!trade_id) return res.status(400).json({ error: 'trade_id required' });
    const info = db.prepare('DELETE FROM track_record WHERE trade_id = ?').run(trade_id);
    if (info.changes === 0) return res.status(404).json({ error: 'Trade not found in track record: ' + trade_id });
    publicStatsCache.clear();
    res.json({ ok: true });
  } catch (err) {
    console.error('[track-record]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports._positionToTrackRecord = positionToTrackRecord;
