const { Router } = require('express');
const db = require('../lib/db');
const { authRequired } = require('../lib/auth');
const { CANONICAL_PORTFOLIO_USER_ID, portfolioUserId } = require('../lib/portfolio-config');

const router = Router();

/* ── Position quote cache ────────────────────────────────────────────────────
   The portfolio table paints enriched immediately from this cache, then the
   background live fetch refreshes it and writes fresh values back so the next
   load is instant. Keyed by a stable leg signature: ticker|strike|expiry|type. */
function quoteCacheKey(q) {
  const ticker = String(q.ticker || '').toUpperCase();
  const strike = q.strike == null ? '' : Number(q.strike);
  const expiry = String(q.expiry || q.expiration || '').slice(0, 10);
  const type = String(q.type || q.option_type || '').toLowerCase().includes('put') ? 'put' : 'call';
  return `${ticker}|${strike}|${expiry}|${type}`;
}

const QUOTE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; /* 6h */

function selectPositionRows(where, params) {
  return db
    .prepare(
      `
    SELECT id, ticker, direction, structure, legs_json,
           entry_date, net_debit, p1_target, p2_target,
           status, closed_date, notes, source_idea, user_id,
           created_at, updated_at
    FROM positions
    WHERE ${where.join(' AND ')}
    ORDER BY (status = 'open') DESC, entry_date DESC, id DESC
  `
    )
    .all(...params);
}

/* GET /positions/public-current — canonical open portfolio (read-only). */
router.get('/positions/public-current', (req, res) => {
  try {
    const rows = selectPositionRows(['user_id = ?', "status = 'open'"], [CANONICAL_PORTFOLIO_USER_ID]);
    res.json(rows);
  } catch (e) {
    console.error('[positions] public-current failed:', e.message);
    res.status(500).json({ error: 'Failed to load public positions' });
  }
});

/* GET /positions/broker-current — the Expiry Risk panel reads this. There is no
   external brokerage in the self-hosted build, so it mirrors the open book; the
   page maps it through the same mapServerPosition() as /public-current. */
router.get('/positions/broker-current', (req, res) => {
  try {
    const rows = selectPositionRows(['user_id = ?', "status = 'open'"], [CANONICAL_PORTFOLIO_USER_ID]);
    res.json(rows);
  } catch (e) {
    console.error('[positions] broker-current failed:', e.message);
    res.status(500).json({ error: 'Failed to load broker positions' });
  }
});

/* GET /positions/quotes-cache — fast, cache-only enrichment for first paint. */
router.get('/positions/quotes-cache', authRequired, (req, res) => {
  try {
    const cutoffArg = '-' + Math.round(QUOTE_CACHE_TTL_MS / 1000) + ' seconds';
    const rows = db
      .prepare(
        `
      SELECT cache_key, ticker, last_price, delta, theta, gamma, vega, beta,
             earnings_date, updated_at
      FROM position_quote_cache
      WHERE updated_at >= datetime('now', ?)
    `
      )
      .all(cutoffArg);
    const out = {};
    for (const r of rows) {
      out[r.cache_key] = {
        ticker: r.ticker,
        lastPrice: r.last_price,
        delta: r.delta,
        theta: r.theta,
        gamma: r.gamma,
        vega: r.vega,
        beta: r.beta,
        earningsDate: r.earnings_date,
        updatedAt: r.updated_at,
      };
    }
    res.json(out);
  } catch (e) {
    console.error('[positions] quotes-cache GET failed:', e.message);
    res.json({});
  }
});

/* POST /positions/quotes-cache — persist fresh live quotes after the background
   fetch resolves, so the NEXT page load paints instantly from cache. */
router.post('/positions/quotes-cache', authRequired, (req, res) => {
  try {
    try {
      db.prepare("DELETE FROM position_quote_cache WHERE updated_at < datetime('now','-7 day')").run();
    } catch (e) {
      /* best-effort cleanup */
    }
    const items = Array.isArray(req.body) ? req.body : [];
    if (!items.length) return res.json({ ok: true, saved: 0 });
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const stmt = db.prepare(`
      INSERT INTO position_quote_cache
        (cache_key, ticker, last_price, delta, theta, gamma, vega, beta, earnings_date, updated_at)
      VALUES (@key, @ticker, @last_price, @delta, @theta, @gamma, @vega, @beta, @earnings_date, datetime('now'))
      ON CONFLICT(cache_key) DO UPDATE SET
        ticker=excluded.ticker, last_price=excluded.last_price, delta=excluded.delta,
        theta=excluded.theta, gamma=excluded.gamma, vega=excluded.vega, beta=excluded.beta,
        earnings_date=excluded.earnings_date, updated_at=datetime('now')
    `);
    let saved = 0;
    const tx = db.transaction((rows) => {
      for (const q of rows) {
        if (!q || q.lastPrice == null || !q.ticker) continue;
        stmt.run({
          key: quoteCacheKey(q),
          ticker: String(q.ticker).toUpperCase(),
          last_price: num(q.lastPrice),
          delta: num(q.delta),
          theta: num(q.theta),
          gamma: num(q.gamma),
          vega: num(q.vega),
          beta: num(q.beta),
          earnings_date: q.earningsDate ? String(q.earningsDate).slice(0, 10) : null,
        });
        saved++;
      }
    });
    tx(items);
    res.json({ ok: true, saved });
  } catch (e) {
    console.error('[positions] quotes-cache POST failed:', e.message);
    res.status(500).json({ error: 'Failed to cache quotes' });
  }
});

/* GET /positions — all positions for the current user, open first. */
router.get('/positions', authRequired, (req, res) => {
  try {
    const userId = portfolioUserId(req.user);
    const status = String(req.query.status || '').toLowerCase();
    const allowed = new Set(['open', 'closed', 'expired']);
    const where = ['user_id = ?'];
    const params = [userId];
    if (allowed.has(status)) {
      where.push('status = ?');
      params.push(status);
    }
    const rows = selectPositionRows(where, params);
    res.json(rows);
  } catch (e) {
    console.error('[positions] GET failed:', e.message);
    res.status(500).json({ error: 'Failed to load positions' });
  }
});

/* POST /positions — create a new position. Body: ticker, direction, structure,
   legs[], entry_date, net_debit, p1_target, p2_target, notes, source_idea. */
router.post('/positions', authRequired, (req, res) => {
  try {
    const userId = portfolioUserId(req.user);
    const body = req.body || {};
    const ticker = String(body.ticker || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    const direction = String(body.direction || 'long').toLowerCase() === 'short' ? 'short' : 'long';
    const structure = String(body.structure || 'Single').trim().slice(0, 80) || 'Single';
    const entryDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.entry_date || body.entryDate || ''))
      ? String(body.entry_date || body.entryDate)
      : new Date().toISOString().slice(0, 10);
    const legs = Array.isArray(body.legs) ? body.legs : [];
    if (!legs.length) return res.status(400).json({ error: 'at least one leg required' });
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const info = db
      .prepare(
        `INSERT INTO positions
          (ticker, direction, structure, legs_json, entry_date, net_debit, p1_target, p2_target,
           status, notes, source_idea, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .run(
        ticker,
        direction,
        structure,
        JSON.stringify(legs),
        entryDate,
        num(body.net_debit ?? body.netDebit),
        num(body.p1_target ?? body.p1Target),
        num(body.p2_target ?? body.p2Target),
        body.notes ? String(body.notes) : null,
        body.source_idea ? String(body.source_idea) : null,
        userId
      );
    const row = db.prepare('SELECT * FROM positions WHERE id = ?').get(info.lastInsertRowid);
    res.json({ ok: true, position: row });
  } catch (e) {
    console.error('[positions] create failed:', e.message);
    res.status(500).json({ error: 'Failed to create position' });
  }
});

/* PATCH /positions/:id — update editable position fields and option legs. */
router.patch('/positions/:id', authRequired, (req, res) => {
  try {
    const userId = portfolioUserId(req.user);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid position id' });

    const row = db.prepare(`SELECT * FROM positions WHERE id = ? AND user_id = ?`).get(id, userId);
    if (!row) return res.status(404).json({ error: 'Position not found' });

    function cleanDate(value, fallback) {
      const s = value == null ? fallback : String(value).slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
    }
    function cleanDirection(value, fallback) {
      const s = String(value || fallback || '').toLowerCase();
      return s === 'short' ? 'short' : 'long';
    }
    function cleanNumber(value, fallback) {
      if (value === null) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }
    function cleanLeg(leg) {
      const dir = cleanDirection(leg && leg.direction, 'long');
      const optRaw = String((leg && (leg.option_type || leg.optionType || leg.type)) || 'call').toLowerCase();
      const opt = optRaw.includes('put') ? 'put' : 'call';
      const out = {
        direction: dir,
        option_type: opt,
        expiration: cleanDate(leg && leg.expiration, row.entry_date),
        strike: cleanNumber(leg && leg.strike, null),
        size: Math.max(0, cleanNumber(leg && leg.size, 0) || 0),
        premium: cleanNumber(leg && leg.premium, null),
        mult: Math.max(1, cleanNumber(leg && leg.mult, 100) || 100),
      };
      ['symbol', 'bid', 'mid', 'ask', 'last', 'exit_premium'].forEach((key) => {
        if (!leg || leg[key] == null || leg[key] === '') return;
        out[key] = key === 'symbol' ? String(leg[key]) : cleanNumber(leg[key], null);
      });
      return out;
    }

    const body = req.body || {};
    const ticker = String(body.ticker || row.ticker || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
    const structure = String(body.structure || row.structure || '').trim().slice(0, 80) || row.structure;
    const direction = cleanDirection(body.direction, row.direction);
    const entryDate = cleanDate(body.entryDate || body.entry_date, row.entry_date);
    const legs = Array.isArray(body.legs) ? body.legs.map(cleanLeg).filter((l) => l.size > 0) : null;
    const legsJson = legs && legs.length ? JSON.stringify(legs) : row.legs_json;
    const netDebit = Object.prototype.hasOwnProperty.call(body, 'netDebit')
      ? cleanNumber(body.netDebit, row.net_debit)
      : Object.prototype.hasOwnProperty.call(body, 'net_debit')
      ? cleanNumber(body.net_debit, row.net_debit)
      : row.net_debit;
    const p1 = Object.prototype.hasOwnProperty.call(body, 'p1Target') ? cleanNumber(body.p1Target, row.p1_target) : row.p1_target;
    const p2 = Object.prototype.hasOwnProperty.call(body, 'p2Target') ? cleanNumber(body.p2Target, row.p2_target) : row.p2_target;
    const notes = Object.prototype.hasOwnProperty.call(body, 'notes') ? String(body.notes || '') : row.notes;
    const sourceIdea = Object.prototype.hasOwnProperty.call(body, 'sourceIdea') ? String(body.sourceIdea || '') : row.source_idea;

    db.prepare(
      `
      UPDATE positions
      SET ticker = ?, direction = ?, structure = ?, legs_json = ?, entry_date = ?,
          net_debit = ?, p1_target = ?, p2_target = ?, notes = ?, source_idea = ?,
          updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `
    ).run(ticker, direction, structure, legsJson, entryDate, netDebit, p1, p2, notes, sourceIdea, id, userId);

    const updated = db.prepare(`SELECT * FROM positions WHERE id = ? AND user_id = ?`).get(id, userId);
    res.json({ ok: true, position: updated });
  } catch (e) {
    console.error('[positions] update failed:', e.message);
    res.status(500).json({ error: 'Failed to update position' });
  }
});

/* DELETE /positions/:id — remove a position outright. */
router.delete('/positions/:id', authRequired, (req, res) => {
  try {
    const userId = portfolioUserId(req.user);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid position id' });
    const info = db.prepare('DELETE FROM positions WHERE id = ? AND user_id = ?').run(id, userId);
    if (info.changes === 0) return res.status(404).json({ error: 'Position not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[positions] delete failed:', e.message);
    res.status(500).json({ error: 'Failed to delete position' });
  }
});

/* PATCH /positions/:id/close — close all or part of an open position. The
   Realized page reads closed rows from this same table, so closing here is the
   source-of-truth transfer from Current Portfolio to Realized. */
router.patch('/positions/:id/close', authRequired, (req, res) => {
  try {
    const userId = portfolioUserId(req.user);
    const id = Number(req.params.id);
    const closedQty = Math.max(0, Number(req.body.closedQty || req.body.qty || 0));
    const exitPrice = Number(req.body.exitPrice);
    const exitDate = String(req.body.exitDate || new Date().toISOString().slice(0, 10)).slice(0, 10);

    if (!id) return res.status(400).json({ error: 'Invalid position id' });
    if (!Number.isFinite(exitPrice) || exitPrice < 0) return res.status(400).json({ error: 'Invalid exit price' });

    const row = db.prepare(`SELECT * FROM positions WHERE id = ? AND user_id = ? AND status = 'open'`).get(id, userId);
    if (!row) return res.status(404).json({ error: 'Open position not found' });

    let legs = [];
    try {
      legs = JSON.parse(row.legs_json || '[]');
    } catch (e) {
      legs = [];
    }
    if (!Array.isArray(legs) || !legs.length) return res.status(400).json({ error: 'Position has no legs' });

    const rawLegIndex = req.body.legIndex;
    const legIndex = rawLegIndex === undefined || rawLegIndex === null || rawLegIndex === '' ? null : Number(rawLegIndex);
    const hasLegIndex = Number.isInteger(legIndex) && legIndex >= 0;
    if (hasLegIndex && !legs[legIndex]) return res.status(400).json({ error: 'Invalid leg index' });

    const primary = legs.find((l) => l && l.direction === 'long') || legs[0];
    const targetLeg = hasLegIndex ? legs[legIndex] : primary;
    const currentQty = Math.max(0, Number((targetLeg && targetLeg.size) || 0));
    if (!currentQty) return res.status(400).json({ error: 'Position quantity is zero' });

    const qtyToClose = Math.min(currentQty, closedQty || currentQty);
    if (qtyToClose <= 0) return res.status(400).json({ error: 'Invalid close quantity' });

    function legDirection(leg) {
      return String((leg && leg.direction) || '').toLowerCase() === 'short' ? 'short' : 'long';
    }
    function normalizeDirection(value) {
      return String(value || '').toLowerCase() === 'short' ? 'short' : 'long';
    }
    function legStructure(leg) {
      const dir = legDirection(leg) === 'short' ? 'Short' : 'Long';
      const opt = String((leg && (leg.option_type || leg.optionType || leg.type)) || '').toLowerCase().includes('put') ? 'Put' : 'Call';
      return `${dir} ${opt}`;
    }
    function legEntryDebit(leg, size) {
      const premium = Number(leg && leg.premium);
      const mult = Number((leg && leg.mult) || 100);
      if (!Number.isFinite(premium)) return null;
      return (legDirection(leg) === 'short' ? -1 : 1) * premium * size * mult;
    }
    function withExitPremium(leg, size) {
      const out = Object.assign({}, leg);
      out.size = size;
      out.exit_premium = exitPrice;
      return out;
    }
    function cloneLegsWithSize(primaryQty, includeExit) {
      const frac = currentQty > 0 ? primaryQty / currentQty : 1;
      return legs.map((leg, idx) => {
        const out = Object.assign({}, leg);
        out.size = Number(leg.size || 0) * frac;
        if (includeExit) {
          const isPrimary = leg === primary || idx === legs.indexOf(primary);
          out.exit_premium = isPrimary ? exitPrice : 0;
        } else {
          delete out.exit_premium;
        }
        return out;
      });
    }

    const tx = db.transaction(() => {
      if (hasLegIndex) {
        const closedLeg = withExitPremium(targetLeg, qtyToClose);
        const closedNetDebit = legEntryDebit(targetLeg, qtyToClose);
        const rowNetDebit = row.net_debit == null ? null : Number(row.net_debit);
        const remainingNetDebit = rowNetDebit == null || closedNetDebit == null ? rowNetDebit : rowNetDebit - closedNetDebit;
        const remainingLegs = legs
          .map((leg, idx) => {
            if (idx !== legIndex) return Object.assign({}, leg);
            const remainingSize = Number(leg.size || 0) - qtyToClose;
            if (remainingSize <= 0) return null;
            const out = Object.assign({}, leg);
            out.size = remainingSize;
            delete out.exit_premium;
            return out;
          })
          .filter(Boolean);

        if (!remainingLegs.length) {
          db.prepare(
            `
            UPDATE positions
            SET status = 'closed', closed_date = ?, structure = ?, direction = ?, legs_json = ?, net_debit = ?, updated_at = datetime('now')
            WHERE id = ? AND user_id = ?
          `
          ).run(exitDate, legStructure(targetLeg), legDirection(targetLeg), JSON.stringify([closedLeg]), closedNetDebit, id, userId);
          return { partial: false, legClosed: true, closedId: id };
        }

        const remainingStructure = remainingLegs.length === 1 ? legStructure(remainingLegs[0]) : row.structure;
        const remainingDirection = remainingLegs.length === 1 ? legDirection(remainingLegs[0]) : normalizeDirection(row.direction);
        db.prepare(
          `
          UPDATE positions
          SET structure = ?, direction = ?, legs_json = ?, net_debit = ?, updated_at = datetime('now')
          WHERE id = ? AND user_id = ?
        `
        ).run(remainingStructure, remainingDirection, JSON.stringify(remainingLegs), remainingNetDebit, id, userId);

        const info = db
          .prepare(
            `
          INSERT INTO positions (
            ticker, direction, structure, legs_json, entry_date, net_debit,
            p1_target, p2_target, status, closed_date, notes, source_idea,
            user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, datetime('now'), datetime('now'))
        `
          )
          .run(
            row.ticker,
            legDirection(targetLeg),
            legStructure(targetLeg),
            JSON.stringify([closedLeg]),
            row.entry_date,
            closedNetDebit,
            row.p1_target,
            row.p2_target,
            exitDate,
            row.notes,
            row.source_idea,
            userId
          );
        return { partial: qtyToClose < currentQty, legClosed: true, openId: id, closedId: info.lastInsertRowid };
      }

      if (qtyToClose < currentQty) {
        const remainingQty = currentQty - qtyToClose;
        const closedNetDebit = row.net_debit == null ? null : Number(row.net_debit) * (qtyToClose / currentQty);
        const remainingNetDebit = row.net_debit == null ? null : Number(row.net_debit) * (remainingQty / currentQty);

        db.prepare(
          `
          UPDATE positions
          SET legs_json = ?, net_debit = ?, updated_at = datetime('now')
          WHERE id = ? AND user_id = ?
        `
        ).run(JSON.stringify(cloneLegsWithSize(remainingQty, false)), remainingNetDebit, id, userId);

        const info = db
          .prepare(
            `
          INSERT INTO positions (
            ticker, direction, structure, legs_json, entry_date, net_debit,
            p1_target, p2_target, status, closed_date, notes, source_idea,
            user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, datetime('now'), datetime('now'))
        `
          )
          .run(
            row.ticker,
            normalizeDirection(row.direction),
            row.structure,
            JSON.stringify(cloneLegsWithSize(qtyToClose, true)),
            row.entry_date,
            closedNetDebit,
            row.p1_target,
            row.p2_target,
            exitDate,
            row.notes,
            row.source_idea,
            userId
          );
        return { partial: true, openId: id, closedId: info.lastInsertRowid };
      }

      db.prepare(
        `
        UPDATE positions
        SET status = 'closed', closed_date = ?, legs_json = ?, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?
      `
      ).run(exitDate, JSON.stringify(cloneLegsWithSize(currentQty, true)), id, userId);
      return { partial: false, closedId: id };
    });

    res.json(Object.assign({ ok: true }, tx()));
  } catch (e) {
    console.error('[positions] close failed:', e.message);
    res.status(500).json({ error: 'Failed to close position' });
  }
});

module.exports = router;
