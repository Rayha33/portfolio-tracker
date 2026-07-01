/*
 * tradestation.js — optional TradeStation account link.
 *
 * The app works fully WITHOUT this (manual entry + CSV import). When the user
 * pastes their TradeStation API key/secret into the panel and approves the
 * browser consent screen, this module keeps the open Positions book and the
 * account balances in sync automatically.
 *
 * Flow (OAuth 2.0 Authorization Code, confidential client):
 *   1. user saves { client_id, client_secret, environment }   -> saveCredentials()
 *   2. browser is sent to authorizeUrl(state)                  -> TradeStation consent
 *   3. TradeStation redirects back with ?code=...&state=...    -> exchangeCode()
 *   4. we hold a long-lived refresh_token and mint short-lived access tokens
 *   5. syncOpenPositions() pulls accounts/balances/positions on a timer + on demand
 *
 * Everything fails soft and never throws out of the timer: a bad token flips
 * `needs_reconnect` and records `last_error` instead of crashing the server.
 */
const db = require('./db');
const { CANONICAL_PORTFOLIO_USER_ID: USER_ID } = require('./portfolio-config');

// ── Constants ───────────────────────────────────────────────────────────────
const SIGNIN_BASE = 'https://signin.tradestation.com';
const AUDIENCE = 'https://api.tradestation.com';
// Data endpoints differ per environment; the sign-in host is shared.
const API_BASE = {
  live: 'https://api.tradestation.com/v3',
  sim: 'https://sim-api.tradestation.com/v3',
};
// Read-only + refresh. We never place orders.
const SCOPES = 'openid profile offline_access MarketData ReadAccount';
const ACCESS_TOKEN_SKEW_MS = 30 * 1000; // refresh a little early
const HTTP_TIMEOUT_MS = 12000;

// Base URL the browser reaches the app at — used to build the OAuth redirect
// URI. Must match a Callback URL registered on the TradeStation API key.
function appBaseUrl() {
  return (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}
function redirectUri() {
  return `${appBaseUrl()}/api/tradestation/callback`;
}

// ── Config row (singleton id=1) ─────────────────────────────────────────────
function ensureRow() {
  db.prepare('INSERT OR IGNORE INTO tradestation_auth (id) VALUES (1)').run();
}
function getConfig() {
  ensureRow();
  return db.prepare('SELECT * FROM tradestation_auth WHERE id = 1').get();
}
function patchConfig(fields) {
  ensureRow();
  const keys = Object.keys(fields);
  if (!keys.length) return getConfig();
  const set = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE tradestation_auth SET ${set}, updated_at = datetime('now') WHERE id = 1`).run(fields);
  return getConfig();
}

// ── HTTP helper ─────────────────────────────────────────────────────────────
async function httpFetch(url, options) {
  if (typeof fetch !== 'function') throw new Error('global fetch unavailable (need Node >= 18)');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({ signal: ctrl.signal }, options));
  } finally {
    clearTimeout(t);
  }
}

// ── OAuth ───────────────────────────────────────────────────────────────────
function apiBaseFor(env) {
  return API_BASE[env === 'live' ? 'live' : 'sim'];
}

/* Persist the OAuth app credentials the user pasted in. Resets any prior
   connection so a stale token can't be used with new credentials. */
function saveCredentials({ client_id, client_secret, environment }) {
  const id = String(client_id || '').trim();
  const secret = String(client_secret || '').trim();
  const env = environment === 'live' ? 'live' : 'sim';
  if (!id) throw new Error('Client ID is required');
  if (!secret) throw new Error('Client Secret is required');
  return patchConfig({
    client_id: id,
    client_secret: secret,
    environment: env,
    refresh_token: null,
    access_token: null,
    access_token_expires_at: null,
    account_ids: null,
    connected: 0,
    needs_reconnect: 0,
    last_error: null,
    last_balances_json: null,
  });
}

/* Build the TradeStation consent URL and remember the CSRF state. */
function authorizeUrl(state) {
  const cfg = getConfig();
  if (!cfg.client_id) throw new Error('No TradeStation credentials saved yet');
  patchConfig({ oauth_state: state });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.client_id,
    audience: AUDIENCE,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
  });
  return `${SIGNIN_BASE}/authorize?${params.toString()}`;
}

/* Exchange the ?code from the callback for tokens and mark connected. */
async function exchangeCode(code) {
  const cfg = getConfig();
  if (!cfg.client_id || !cfg.client_secret) throw new Error('No TradeStation credentials saved');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    code,
    redirect_uri: redirectUri(),
  });
  const res = await httpFetch(`${SIGNIN_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `Token exchange failed (HTTP ${res.status})`);
  }
  if (!json.refresh_token) {
    throw new Error('TradeStation did not return a refresh token — ensure the "offline_access" scope is enabled on the API key');
  }
  patchConfig({
    refresh_token: json.refresh_token,
    access_token: json.access_token || null,
    access_token_expires_at: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : null,
    connected: 1,
    needs_reconnect: 0,
    last_error: null,
    oauth_state: null,
  });
  clearSeededDemoOpenPositions();
  return true;
}

/* Store a refresh token directly (advanced/manual path) and verify it works. */
async function installRefreshToken(refreshToken) {
  const token = String(refreshToken || '').trim();
  if (!token) throw new Error('Refresh token is required');
  patchConfig({ refresh_token: token, connected: 1, needs_reconnect: 0, last_error: null });
  await refreshAccessToken(); // throws (and flips needs_reconnect) if the token is bad
  clearSeededDemoOpenPositions();
  return true;
}

/* Mint a fresh access token from the stored refresh token. */
async function refreshAccessToken() {
  const cfg = getConfig();
  if (!cfg.client_id || !cfg.client_secret) throw new Error('No TradeStation credentials saved');
  if (!cfg.refresh_token) throw new Error('Not connected — no refresh token');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    refresh_token: cfg.refresh_token,
  });
  const res = await httpFetch(`${SIGNIN_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const message = json.error_description || json.error || `Token refresh failed (HTTP ${res.status})`;
    // Only a PERMANENT grant failure (revoked/expired refresh token) forces a
    // re-consent. Transient failures (rate limit, 5xx, network) merely record
    // the error and are retried on the next tick — otherwise a brief IdP blip
    // would kill the "hands-off" auto-sync until the user manually reconnects.
    const permanent =
      res.status >= 400 &&
      res.status < 500 &&
      res.status !== 429 &&
      ['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied'].includes(String(json.error || ''));
    patchConfig(permanent ? { needs_reconnect: 1, last_error: message } : { last_error: message });
    throw new Error(message);
  }
  patchConfig({
    access_token: json.access_token,
    access_token_expires_at: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : Date.now() + 1200 * 1000,
    // TradeStation may rotate the refresh token — keep whichever is newest.
    refresh_token: json.refresh_token || cfg.refresh_token,
    needs_reconnect: 0,
    last_error: null,
  });
  return json.access_token;
}

/* Return a valid access token, refreshing if it is missing or near expiry. */
async function getAccessToken() {
  const cfg = getConfig();
  if (cfg.access_token && cfg.access_token_expires_at && cfg.access_token_expires_at - ACCESS_TOKEN_SKEW_MS > Date.now()) {
    return cfg.access_token;
  }
  return refreshAccessToken();
}

/* Authenticated GET against the environment's API base. Refreshes once on 401. */
async function apiGet(path, { retryOn401 = true } = {}) {
  const cfg = getConfig();
  const base = apiBaseFor(cfg.environment);
  const token = await getAccessToken();
  const res = await httpFetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401 && retryOn401) {
    await refreshAccessToken();
    return apiGet(path, { retryOn401: false });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json && (json.Message || json.error || json.message)) || `TradeStation API ${path} failed (HTTP ${res.status})`);
  }
  return json;
}

/* TradeStation's batch brokerage endpoints return HTTP 200 with a top-level
   `Errors` array (and a partial/empty primary array) when an individual account
   can't be read. Treat that as a hard failure so a partial/empty payload never
   reaches the destructive open-book replace. */
function throwIfAccountErrors(json) {
  if (json && Array.isArray(json.Errors) && json.Errors.length) {
    const msg = json.Errors.map((e) => (e && (e.Message || e.Error || e.AccountID)) || 'account error').join('; ');
    const err = new Error('TradeStation returned account errors: ' + msg);
    err.accountError = true;
    throw err;
  }
}

async function fetchAccountIds() {
  const json = await apiGet('/brokerage/accounts');
  throwIfAccountErrors(json);
  const accounts = Array.isArray(json.Accounts) ? json.Accounts : [];
  const ids = accounts
    .filter((a) => a && a.AccountID && String(a.Status || '').toLowerCase() !== 'closed')
    .map((a) => String(a.AccountID));
  return ids;
}

async function fetchBalances(ids) {
  if (!ids.length) return [];
  const json = await apiGet(`/brokerage/accounts/${ids.join(',')}/balances`);
  throwIfAccountErrors(json);
  return Array.isArray(json.Balances) ? json.Balances : [];
}

async function fetchPositions(ids) {
  if (!ids.length) return [];
  const json = await apiGet(`/brokerage/accounts/${ids.join(',')}/positions`);
  throwIfAccountErrors(json);
  return Array.isArray(json.Positions) ? json.Positions : [];
}

// ── Pure mappers (exported for tests) ───────────────────────────────────────
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* Parse a TradeStation option symbol into its parts.
   Handles the native TS format  "AAPL 260918C200"  /  "SPY 251219P475.5"
   and the OCC/OSI 8-digit strike  "AAPL 260918C00200000" (strike x1000).
   Returns null for anything that isn't an option symbol. */
function parseOptionSymbol(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  const m = s.match(/^([A-Z][A-Z0-9.\/]*)\s+(\d{6})([CP])(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const [, underlying, yymmdd, cp, strikeRaw] = m;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  const expiration = `20${String(yy).padStart(2, '0')}-${mm}-${dd}`;
  let strike;
  if (/^\d{8}$/.test(strikeRaw)) strike = Number(strikeRaw) / 1000; // OSI 8-digit
  else strike = Number(strikeRaw);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { underlying, expiration, option_type: cp === 'P' ? 'put' : 'call', strike };
}

/* True when a TradeStation position is a tradeable, non-zero option — the only
   kind this options tracker can render natively. */
function isOptionPosition(pos) {
  return !!(pos && pos.Symbol && Math.abs(num(pos.Quantity) || 0) > 0 && parseOptionSymbol(pos.Symbol));
}

/* Map one TradeStation OPTION position into a row for the app's `positions`
   table — a single-leg structure the Portfolio page renders natively (identical
   shape to the seed). Returns null for anything that isn't a mappable option
   (equities/futures are counted separately by the caller, not shown, because
   this table is option/strike/expiry-centric and would mislabel a share lot). */
function tsPositionToRow(pos, userId) {
  if (!isOptionPosition(pos)) return null;
  const qty = Math.abs(num(pos.Quantity) || 0);
  const isShort = String(pos.LongShort || '').toLowerCase() === 'short' || (num(pos.Quantity) || 0) < 0;
  const direction = isShort ? 'short' : 'long';
  const avgPrice = num(pos.AveragePrice);
  const opt = parseOptionSymbol(pos.Symbol);
  const entryDate = String(pos.Timestamp || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const mult = 100;
  const leg = {
    direction,
    option_type: opt.option_type,
    type: opt.option_type,
    expiration: opt.expiration,
    strike: opt.strike,
    size: qty,
    premium: avgPrice,
    mult,
    symbol: pos.Symbol,
  };
  const netDebit = avgPrice != null ? Math.round((isShort ? -1 : 1) * avgPrice * qty * mult * 100) / 100 : null;
  return {
    ticker: opt.underlying,
    direction,
    structure: `${isShort ? 'Short' : 'Long'} ${opt.option_type === 'put' ? 'Put' : 'Call'}`,
    legs_json: JSON.stringify([leg]),
    entry_date: entryDate,
    net_debit: netDebit,
    p1_target: null,
    p2_target: null,
    status: 'open',
    closed_date: null,
    notes: null,
    source_idea: 'TradeStation',
    user_id: userId,
  };
}

/* Collapse raw TradeStation balance rows into the exact field names the
   Portfolio panel reads (equity / cash / todaysPl / unrealizedPl), summed
   across accounts. */
function normalizeBalances(balances) {
  const rows = Array.isArray(balances) ? balances : balances ? [balances] : [];
  let equity = null,
    cash = null,
    todaysPl = null,
    unrealizedPl = null;
  const add = (acc, v) => (v == null ? acc : (acc || 0) + v);
  for (const b of rows) {
    if (!b) continue;
    const detail = b.BalanceDetail || {};
    equity = add(equity, num(b.Equity));
    cash = add(cash, num(b.CashBalance));
    todaysPl = add(todaysPl, num(b.TodaysProfitLoss != null ? b.TodaysProfitLoss : detail.TodaysProfitLoss));
    unrealizedPl = add(unrealizedPl, num(b.UnrealizedProfitLoss != null ? b.UnrealizedProfitLoss : detail.UnrealizedProfitLoss));
  }
  return { equity, cash, todaysPl, unrealizedPl };
}

/* Realized summary for the panel, taken from the same source the Realized page
   uses (the track_record table) so the numbers agree. */
function realizedSummary() {
  try {
    const r = db
      .prepare(
        `SELECT
           COALESCE(SUM(realized_pnl), 0) AS total,
           SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN win = 0 THEN 1 ELSE 0 END) AS losses
         FROM track_record
         WHERE status = 'resolved' AND realized_pnl IS NOT NULL`
      )
      .get();
    const wins = Number(r.wins || 0);
    const losses = Number(r.losses || 0);
    const decided = wins + losses;
    return {
      total: Math.round(Number(r.total || 0) * 100) / 100,
      wins,
      losses,
      winRate: decided ? Math.round((wins / decided) * 1000) / 10 : null,
    };
  } catch (e) {
    return { total: null, wins: null, losses: null, winRate: null };
  }
}

// ── Sync ────────────────────────────────────────────────────────────────────
let syncInFlight = false;

/* Remove the seeded demo open book when an account is first linked, so the live
   TradeStation positions don't render alongside fictional demo rows. */
function clearSeededDemoOpenPositions() {
  try {
    db.prepare("DELETE FROM positions WHERE user_id = ? AND status = 'open' AND source_idea = 'demo'").run(USER_ID);
  } catch (e) {
    /* best-effort */
  }
}

/* Pull accounts -> balances + positions, then replace the TradeStation-sourced
   open positions with the live book. Manually-entered open rows and all
   closed/expired rows (the Realized page) are never touched. Balances are
   cached for instant panel paint. */
async function syncOpenPositions() {
  if (syncInFlight) {
    const c = getConfig();
    let cached = null;
    try {
      cached = c.last_balances_json ? JSON.parse(c.last_balances_json) : null;
    } catch (e) {
      cached = null;
    }
    return { skipped: true, reason: 'sync already running', balances: (cached && cached.balances) || null, skippedEquity: (cached && Number(cached.skippedEquity)) || 0 };
  }
  const cfg = getConfig();
  if (!cfg.refresh_token) throw new Error('Not connected to TradeStation');
  syncInFlight = true;
  try {
    // Always re-fetch the account list so a renumbered/closed account can never
    // pin a stale id that returns per-account errors forever.
    const ids = await fetchAccountIds();
    patchConfig({ account_ids: ids.join(',') });
    if (!ids.length) throw new Error('No TradeStation accounts found for this login');

    // Fetch FIRST — only mutate the DB once we have a good positions payload, so
    // a transient API error (including a 200-with-Errors soft failure, which
    // fetchPositions now throws on) never wipes the open book and leaves it empty.
    const [rawBalances, rawPositions] = await Promise.all([fetchBalances(ids), fetchPositions(ids)]);
    const balances = normalizeBalances(rawBalances);

    const rows = [];
    let skippedEquity = 0;
    for (const p of rawPositions) {
      const row = tsPositionToRow(p, USER_ID);
      if (row) rows.push(row);
      else if (p && p.Symbol && Math.abs(num(p.Quantity) || 0) > 0) skippedEquity++; // non-option lot
    }
    const insert = db.prepare(`
      INSERT INTO positions
        (ticker, direction, structure, legs_json, entry_date, net_debit, p1_target, p2_target,
         status, closed_date, notes, source_idea, user_id, created_at, updated_at)
      VALUES (@ticker, @direction, @structure, @legs_json, @entry_date, @net_debit, @p1_target, @p2_target,
              @status, @closed_date, @notes, @source_idea, @user_id, datetime('now'), datetime('now'))
    `);
    // Replace ONLY the TradeStation-sourced open rows. Hand-entered/CSV positions
    // (and the demo book, which is cleared on connect) are left untouched.
    const replaceOpenBook = db.transaction((newRows) => {
      db.prepare("DELETE FROM positions WHERE user_id = ? AND status = 'open' AND source_idea = 'TradeStation'").run(USER_ID);
      for (const row of newRows) insert.run(row);
    });
    replaceOpenBook(rows);

    patchConfig({
      connected: 1,
      needs_reconnect: 0,
      last_error: null,
      last_sync_at: new Date().toISOString(),
      last_balances_json: JSON.stringify({ balances, skippedEquity }),
    });
    return { ok: true, positions: rows.length, skippedEquity, balances, syncedAt: new Date().toISOString() };
  } catch (e) {
    patchConfig({ last_error: e.message });
    throw e;
  } finally {
    syncInFlight = false;
  }
}

/* Public status the panel polls. Never throws. */
function status() {
  const cfg = getConfig();
  return {
    connected: !!cfg.connected && !!cfg.refresh_token,
    needsReconnect: !!cfg.needs_reconnect,
    hasCredentials: !!(cfg.client_id && cfg.client_secret),
    environment: cfg.environment || 'sim',
    redirectUri: redirectUri(),
    lastSyncAt: cfg.last_sync_at || null,
    lastError: cfg.last_error || null,
  };
}

/* Balances + realized summary for the panel (cached balances + live-ish sync). */
async function portfolioSummary({ refresh = false } = {}) {
  const cfg = getConfig();
  let balances = null;
  let skippedEquity = 0;
  try {
    const cached = cfg.last_balances_json ? JSON.parse(cfg.last_balances_json) : null;
    if (cached && cached.balances) {
      balances = cached.balances;
      skippedEquity = Number(cached.skippedEquity) || 0;
    } else if (cached && 'equity' in cached) {
      balances = cached; // tolerate an older cache shape
    }
  } catch (e) {
    balances = null;
  }
  if (refresh || !balances) {
    const r = await syncOpenPositions();
    balances = r.balances;
    skippedEquity = r.skippedEquity || 0;
  }
  return { balances, realized: realizedSummary(), skippedEquity, lastSyncAt: getConfig().last_sync_at || null };
}

function disconnect() {
  return patchConfig({
    refresh_token: null,
    access_token: null,
    access_token_expires_at: null,
    account_ids: null,
    connected: 0,
    needs_reconnect: 0,
    last_error: null,
    last_balances_json: null,
    oauth_state: null,
  });
}

module.exports = {
  // config / status
  getConfig,
  status,
  saveCredentials,
  disconnect,
  redirectUri,
  appBaseUrl,
  // oauth
  authorizeUrl,
  exchangeCode,
  installRefreshToken,
  refreshAccessToken,
  getAccessToken,
  // data
  fetchAccountIds,
  fetchBalances,
  fetchPositions,
  syncOpenPositions,
  portfolioSummary,
  realizedSummary,
  // pure mappers (tested directly)
  parseOptionSymbol,
  isOptionPosition,
  tsPositionToRow,
  normalizeBalances,
};
