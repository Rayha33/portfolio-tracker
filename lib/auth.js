/*
 * auth.js — no-login single-user shim.
 *
 * This build has no accounts: `authRequired` simply attaches a fixed local
 * user to the request so the route code (which reads req.user) works without a
 * login. There is nothing to authenticate against — the whole server is meant
 * to run on your own machine / private network.
 */
const { CANONICAL_PORTFOLIO_USER_ID } = require('./portfolio-config');

const LOCAL_USER = Object.freeze({
  id: CANONICAL_PORTFOLIO_USER_ID,
  email: 'local@portfolio-tracker',
  name: 'Local',
  role: 'admin',
});

function authRequired(req, res, next) {
  req.user = LOCAL_USER;
  next();
}

module.exports = { authRequired, LOCAL_USER };
