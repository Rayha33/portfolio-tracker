-- Portfolio Tracker schema. Applied idempotently on every boot (lib/db.js).

-- Open / closed / expired positions. Each row is one structure (single option,
-- vertical, calendar, …). The option legs live in legs_json as an array of
-- { direction, option_type, expiration, strike, size, premium, mult, exit_premium, ... }.
CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker      TEXT    NOT NULL,
  direction   TEXT    NOT NULL CHECK (direction IN ('long','short')),
  structure   TEXT    NOT NULL,
  legs_json   TEXT    NOT NULL,
  entry_date  TEXT    NOT NULL,
  net_debit   REAL,
  p1_target   REAL,
  p2_target   REAL,
  status      TEXT    NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','closed','expired')),
  closed_date TEXT,
  notes       TEXT,
  source_idea TEXT,
  user_id     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_positions_user_status ON positions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_positions_ticker      ON positions(ticker);

-- Realized track record. Powers the equity curve + win-rate stats on the
-- Realized page. Rows are written when a position is closed (and by the seed).
CREATE TABLE IF NOT EXISTS track_record (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id          TEXT UNIQUE NOT NULL,
  ticker            TEXT NOT NULL,
  direction         TEXT NOT NULL,
  rating            TEXT NOT NULL,
  entry_price       REAL NOT NULL,
  price_target      REAL,
  catalyst          TEXT,
  catalyst_date     TEXT,
  option_structure  TEXT,
  option_expiry     TEXT,
  entry_premium     REAL,
  verdict_score     REAL,
  macro_factor      REAL,
  kpi_momentum      REAL,
  entry_date        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  backfilled        INTEGER NOT NULL DEFAULT 0,
  entry_hash        TEXT,
  current_price     REAL,
  resolved_date     TEXT,
  resolved_price    REAL,
  stock_return_pct  REAL,
  direction_correct INTEGER,
  win               INTEGER,
  outcome_hash      TEXT,
  shares            INTEGER DEFAULT 100,
  realized_pnl      REAL,
  price_basis       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_track_record_ticker  ON track_record(ticker);
CREATE INDEX IF NOT EXISTS idx_track_record_status  ON track_record(status);
CREATE INDEX IF NOT EXISTS idx_track_status_date    ON track_record(status, entry_date);

-- Server-side cache of the latest option marks/greeks per leg, so the portfolio
-- table paints enriched immediately on load (before the live refresh resolves).
CREATE TABLE IF NOT EXISTS position_quote_cache (
  cache_key     TEXT PRIMARY KEY,
  ticker        TEXT,
  last_price    REAL,
  delta         REAL,
  theta         REAL,
  gamma         REAL,
  vega          REAL,
  beta          REAL,
  earnings_date TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_position_quote_cache_updated_at ON position_quote_cache(updated_at);

-- Optional company-name lookup for the Realized table. Populated by the seed.
CREATE TABLE IF NOT EXISTS stocks (
  symbol       TEXT PRIMARY KEY,
  company_name TEXT,
  beta         REAL,
  sector       TEXT,
  industry     TEXT
);

-- TradeStation connection (optional, single row id=1). Holds the OAuth app
-- credentials the user pastes in, the tokens minted from the browser consent
-- flow, and the last sync bookkeeping. Everything is nullable so a fresh clone
-- boots with an empty, disconnected row and the "no API keys" default stands.
-- Secrets are stored as-is (single-user, self-hosted machine) — see README.
CREATE TABLE IF NOT EXISTS tradestation_auth (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  client_id                TEXT,
  client_secret            TEXT,
  environment              TEXT NOT NULL DEFAULT 'sim'
                             CHECK (environment IN ('live','sim')),
  oauth_state              TEXT,           -- CSRF nonce for the in-flight authorize round-trip
  refresh_token            TEXT,           -- long-lived; mints access tokens
  access_token             TEXT,           -- short-lived (~20 min)
  access_token_expires_at  INTEGER,        -- epoch ms
  account_ids              TEXT,           -- comma-separated TradeStation account ids
  connected                INTEGER NOT NULL DEFAULT 0,
  needs_reconnect          INTEGER NOT NULL DEFAULT 0,
  last_sync_at             TEXT,
  last_error               TEXT,
  last_balances_json       TEXT,           -- cached normalized balances for instant panel paint
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
