/*
 * tradestation.js — the optional TradeStation link API + browser OAuth flow.
 *
 * The Portfolio page's "TradeStation Live" panel codes against this contract:
 *   GET  /tradestation/status        -> { connected, needsReconnect, hasCredentials, environment, redirectUri, lastSyncAt, lastError }
 *   GET  /tradestation/portfolio     -> { balances, realized, lastSyncAt }
 *   POST /tradestation/credentials   -> save { client_id, client_secret, environment }
 *   GET  /tradestation/connect       -> 302 to TradeStation consent
 *   GET  /tradestation/callback      -> handles ?code=..&state=.. -> tokens -> first sync -> redirect back
 *   POST /tradestation/sync          -> refresh open book + balances now
 *   POST /tradestation/token         -> advanced: install a refresh token directly
 *   POST /tradestation/disconnect    -> forget tokens
 *
 * All endpoints fail soft with JSON errors; the browser-facing callback returns
 * a tiny HTML page so a failed link is readable instead of a raw JSON blob.
 */
const { Router } = require('express');
const crypto = require('crypto');
const ts = require('../lib/tradestation');
const { authRequired } = require('../lib/auth');

const router = Router();

/* GET /tradestation/status — panel polls this to decide what to render. */
router.get('/tradestation/status', (req, res) => {
  try {
    res.json(ts.status());
  } catch (e) {
    console.error('[tradestation] status failed:', e.message);
    res.status(500).json({ error: 'Failed to read TradeStation status' });
  }
});

/* GET /tradestation/portfolio — balances + realized summary for the panel. */
router.get('/tradestation/portfolio', authRequired, async (req, res) => {
  try {
    const st = ts.status();
    if (!st.connected) return res.status(409).json({ error: 'Not connected to TradeStation' });
    const summary = await ts.portfolioSummary({ refresh: false });
    res.json(summary);
  } catch (e) {
    console.error('[tradestation] portfolio failed:', e.message);
    res.status(502).json({ error: e.message || 'Failed to load TradeStation account' });
  }
});

/* POST /tradestation/credentials — the user pastes their API key + secret here. */
router.post('/tradestation/credentials', authRequired, (req, res) => {
  try {
    const { client_id, clientId, client_secret, clientSecret, environment } = req.body || {};
    ts.saveCredentials({
      client_id: client_id || clientId,
      client_secret: client_secret || clientSecret,
      environment,
    });
    res.json({ ok: true, status: ts.status() });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Invalid credentials' });
  }
});

/* GET /tradestation/connect — kick off the browser consent round-trip. */
router.get('/tradestation/connect', authRequired, (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    const url = ts.authorizeUrl(state);
    res.redirect(url);
  } catch (e) {
    res.status(400).send(callbackPage('Could not start TradeStation sign-in', e.message, false));
  }
});

/* GET /tradestation/callback — TradeStation redirects the browser here. */
router.get('/tradestation/callback', authRequired, async (req, res) => {
  const { code, state, error, error_description } = req.query || {};
  try {
    if (error) throw new Error(error_description || error);
    if (!code) throw new Error('No authorization code returned');
    const cfg = ts.getConfig();
    if (!cfg.oauth_state || state !== cfg.oauth_state) throw new Error('State mismatch — please start the connection again');
    await ts.exchangeCode(String(code));
    // First sync so the page paints connected + live positions immediately.
    try {
      await ts.syncOpenPositions();
    } catch (syncErr) {
      console.warn('[tradestation] initial sync after connect failed:', syncErr.message);
    }
    res.send(callbackPage('TradeStation connected', 'Your account is linked. Redirecting to your portfolio…', true));
  } catch (e) {
    console.error('[tradestation] callback failed:', e.message);
    res.status(400).send(callbackPage('TradeStation connection failed', e.message, false));
  }
});

/* POST /tradestation/sync — manual "Sync now". */
router.post('/tradestation/sync', authRequired, async (req, res) => {
  try {
    const result = await ts.syncOpenPositions();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[tradestation] sync failed:', e.message);
    res.status(502).json({ error: e.message || 'Sync failed' });
  }
});

/* POST /tradestation/token — advanced path: install a refresh token directly. */
router.post('/tradestation/token', authRequired, async (req, res) => {
  try {
    const token = (req.body && (req.body.refresh_token || req.body.refreshToken)) || '';
    await ts.installRefreshToken(token);
    try {
      await ts.syncOpenPositions();
    } catch (syncErr) {
      /* token installed; a sync error is surfaced on the next poll */
    }
    res.json({ ok: true, status: ts.status() });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to install token' });
  }
});

/* POST /tradestation/disconnect — forget the link (credentials are kept). */
router.post('/tradestation/disconnect', authRequired, (req, res) => {
  try {
    ts.disconnect();
    res.json({ ok: true, status: ts.status() });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to disconnect' });
  }
});

/* Minimal styled HTML for the browser-facing callback. Posts a message to the
   opener (if this was a popup) and redirects the tab back to the portfolio. */
function callbackPage(title, message, ok) {
  const color = ok ? '#5cb87a' : '#d46b6b';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e6e6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .card{max-width:440px;padding:32px 36px;border:1px solid #23262d;border-radius:14px;background:#161922;text-align:center}
  .dot{width:12px;height:12px;border-radius:50%;background:${color};display:inline-block;margin-right:8px;vertical-align:middle}
  h1{font-size:18px;margin:0 0 10px}
  p{font-size:14px;color:#9aa0aa;line-height:1.5;margin:0 0 18px}
  a{color:#ff8c00;text-decoration:none;font-weight:600}
</style></head><body>
  <div class="card">
    <h1><span class="dot"></span>${esc(title)}</h1>
    <p>${esc(message)}</p>
    <a href="/portfolio.html">Go to portfolio →</a>
  </div>
  <script>
    try { if (window.opener) window.opener.postMessage({ source: 'tradestation', ok: ${ok ? 'true' : 'false'} }, '*'); } catch (e) {}
    ${ok ? "setTimeout(function(){ if (window.opener) { window.close(); } else { window.location = '/portfolio.html'; } }, 1400);" : ''}
  </script>
</body></html>`;
}

module.exports = router;
