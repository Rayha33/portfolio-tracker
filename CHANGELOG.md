# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
