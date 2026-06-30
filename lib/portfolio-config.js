/*
 * portfolio-config.js — single-user portfolio ownership.
 *
 * This build is single-user: there is exactly ONE portfolio, owned by the fixed
 * local user (id '1'). These helpers give the routes a stable owner id so the
 * position queries are always scoped to that single book.
 */
const CANONICAL_PORTFOLIO_USER_ID = '1';

function portfolioUserId(/* user */) {
  return CANONICAL_PORTFOLIO_USER_ID;
}

function isCanonicalPortfolioUser(/* user */) {
  return true;
}

module.exports = {
  CANONICAL_PORTFOLIO_USER_ID,
  portfolioUserId,
  isCanonicalPortfolioUser,
};
