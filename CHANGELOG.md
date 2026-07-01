# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Optional TradeStation link (automatic sync).** A new "TradeStation Live"
  connect flow on the Current Portfolio page: paste your API Key Client ID +
  Secret, pick Simulated or Live, and approve once in the browser. After that
  the app keeps your open **options** book and account balances in sync
  automatically (background timer + on page load + a manual "Sync now"). The app
  still works with no link at all — this only makes updates hands-off.
  - `lib/tradestation.js` — OAuth 2.0 Authorization Code client (confidential),
    automatic access-token refresh, and the accounts/balances/positions sync.
  - `routes/tradestation.js` — `status`, `portfolio`, `credentials`, `connect`,
    `callback`, `sync`, `token` (advanced), and `disconnect`. Read-only scopes
    only (`ReadAccount` + `MarketData`, plus `openid`/`profile`/`offline_access`
    for sign-in and refresh); no trading scope, so the app never places orders.
  - Connecting clears the demo book; each sync then **replaces only the
    TradeStation-sourced open rows** (hand-entered positions are kept, and
    closed/expired rows — the Realized page — are never touched). Only option
    positions are mirrored; the panel discloses how many non-option lots (e.g.
    shares) weren't shown. A sync never wipes the book on an API error (it
    treats a 200-with-`Errors` soft failure as a failure and mutates nothing).
  - Credentials and tokens are stored locally in `db/portfolio.db` (git-ignored).
  - New unit test suite (`test/tradestation.test.mjs`) plus TradeStation checks
    added to the smoke test.
  - New config: `APP_BASE_URL` (OAuth callback base) and
    `TRADESTATION_SYNC_SECONDS` (auto-sync cadence).
- Continuous integration: a dependency-free smoke test (`npm test`) that boots
  the server against a throwaway database and verifies the pages, the core APIs,
  and the add → close → delete write path. Runs in GitHub Actions on Node 20/22/24.
- Contributor scaffolding: `CONTRIBUTING.md`, issue/PR templates, `.editorconfig`,
  `.nvmrc`, and this changelog.
- README: screenshots of both pages, a panel-by-panel feature tour, and badges.

### Fixed
- `.env.example` documented the dead Stooq feed; quotes now come from Yahoo/FRED.
  Added the missing `STARTING_CAPITAL` variable.

## [1.0.0] - 2026-07-01

### Added
- **Current Portfolio** page: live(ish) option marks, per-leg Greeks, expiry
  timeline, expiry-risk worst-case panel, net exposure / heat / beta, sector &
  industry exposure, weighting analysis, and an auto-generated weekly summary.
- **Realized** page: equity curve, performance summary (win rate, R-score,
  Sharpe, max drawdown), daily P/L, and a sortable/searchable trade history with
  broker CSV/PDF import and CSV export.
- Single-user, no login, no API keys. Free keyless market data (Yahoo/FRED) with
  Black-Scholes option marks; degrades gracefully offline.
- Ships with a synthetic demo portfolio, seeded automatically on first run.

[Unreleased]: https://github.com/Rayha33/portfolio-tracker/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Rayha33/portfolio-tracker/releases/tag/v1.0.0
