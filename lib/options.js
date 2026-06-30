/*
 * options.js — Black-Scholes option marks & greeks (pure JS, no deps).
 *
 * There is no free real-time options chain, so when a live underlying price is
 * available (Stooq, via lib/quotes) we compute a theoretical mark + greeks from
 * Black-Scholes. This makes mark-to-market P&L move with the real underlying.
 * Greeks are per-share, in conventional broker units (theta per calendar day,
 * vega per 1% vol move).
 */

// Standard normal CDF via the Abramowitz-Stegun erf approximation.
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  let p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x >= 0) p = 1 - p;
  return p;
}

function normPdf(x) {
  return 0.3989422804014327 * Math.exp(-x * x / 2);
}

function yearFraction(expiry, now = new Date()) {
  const exp = new Date(String(expiry).slice(0, 10) + 'T16:00:00');
  const ms = exp.getTime() - now.getTime();
  return ms / (365 * 24 * 60 * 60 * 1000);
}

/*
 * Price + greeks for one option.
 *   spot   — underlying price
 *   strike — strike
 *   expiry — 'YYYY-MM-DD'
 *   type   — 'call' | 'put'
 *   vol    — annualized volatility (e.g. 0.55)
 *   rate   — annualized risk-free rate (e.g. 0.045)
 * Returns { price, delta, gamma, theta, vega } (per share), or null on bad input.
 */
function priceOption(spot, strike, expiry, type, vol, rate) {
  const S = Number(spot);
  const K = Number(strike);
  const sigma = Number(vol);
  const r = Number(rate);
  if (!(S > 0) || !(K > 0) || !(sigma > 0)) return null;
  const isCall = String(type).toLowerCase().indexOf('put') < 0;

  let T = yearFraction(expiry);
  if (!isFinite(T)) return null;

  // At/after expiry: intrinsic value, ~zero greeks.
  if (T <= 0) {
    const intrinsic = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
    return {
      price: round2(intrinsic),
      delta: isCall ? (S > K ? 1 : 0) : (S < K ? -1 : 0),
      gamma: 0,
      theta: 0,
      vega: 0,
    };
  }
  T = Math.max(T, 1 / 365);

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const disc = Math.exp(-r * T);

  let price, delta, theta;
  const gamma = normPdf(d1) / (S * sigma * sqrtT);
  const vega = S * normPdf(d1) * sqrtT * 0.01; // per 1% vol move

  if (isCall) {
    price = S * normCdf(d1) - K * disc * normCdf(d2);
    delta = normCdf(d1);
    theta = (-(S * normPdf(d1) * sigma) / (2 * sqrtT) - r * K * disc * normCdf(d2)) / 365;
  } else {
    price = K * disc * normCdf(-d2) - S * normCdf(-d1);
    delta = normCdf(d1) - 1;
    theta = (-(S * normPdf(d1) * sigma) / (2 * sqrtT) + r * K * disc * normCdf(-d2)) / 365;
  }

  if (!isFinite(price) || price < 0) return null;
  return {
    price: round2(price),
    delta: round4(delta),
    gamma: round4(gamma),
    theta: round4(theta),
    vega: round4(vega),
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
function round4(x) {
  return Math.round(x * 10000) / 10000;
}

module.exports = { priceOption, normCdf, yearFraction };
