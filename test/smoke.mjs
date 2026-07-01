/**
 * Smoke test — boots the real server against a fresh, throwaway SQLite database
 * and asserts that both pages and the core APIs serve the seeded demo data, then
 * exercises the add → close → delete write path. No external network is needed:
 * it runs with ENABLE_LIVE_QUOTES=0 so prices come from the stored marks.
 *
 * Run with:  npm test   (or  node test/smoke.mjs)
 * Exits 0 if every check passes, 1 otherwise.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(os.tmpdir(), `pt-smoke-${process.pid}-${Date.now()}.db`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const get = (p) => fetch(`${BASE}${p}`);
  const getJSON = async (p) => (await get(p)).json();

  console.log(`\nBooting server on :${PORT} (db=${path.basename(DB)}, live quotes off)…`);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PORTFOLIO_DB_PATH: DB, ENABLE_LIVE_QUOTES: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  srv.stdout.on('data', (d) => { serverLog += d; });
  srv.stderr.on('data', (d) => { serverLog += d; });

  const cleanup = () => {
    try { srv.kill('SIGKILL'); } catch {}
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + ext); } catch {} }
  };

  try {
    // Wait for the server to accept requests (auto-seeds the fresh DB on boot).
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await get('/api/positions')).ok) { up = true; break; } } catch {}
      await sleep(250);
    }
    if (!up) { console.error('Server did not become ready in time. Log:\n' + serverLog); cleanup(); process.exit(1); }

    console.log('\nStatic pages:');
    const portfolioHtml = await (await get('/portfolio.html')).text();
    ok('GET /portfolio.html → 200 + title', /Current Portfolio/.test(portfolioHtml));
    const trackHtml = await (await get('/track-record.html')).text();
    ok('GET /track-record.html → 200 + title', /Realized|Track Record/.test(trackHtml));
    const root = await get('/');
    ok('GET / → 200 and points to portfolio', root.ok && /portfolio\.html/.test(await root.text()));

    console.log('\nRead APIs (seeded demo data):');
    const positions = await getJSON('/api/positions');
    ok('GET /api/positions → non-empty array', Array.isArray(positions) && positions.length >= 1, `len=${positions?.length}`);
    ok('positions have ticker + legs', positions.every((p) => p.ticker && p.legs_json));

    const publicCurrent = await getJSON('/api/positions/public-current');
    ok('GET /api/positions/public-current → array', Array.isArray(publicCurrent) && publicCurrent.length >= 1);

    const trackPublic = await getJSON('/api/track-record/public');
    ok('GET /api/track-record/public → summary', trackPublic && typeof trackPublic.overall_win_rate !== 'undefined');

    const trackMember = await getJSON('/api/track-record/member');
    ok('GET /api/track-record/member → array', Array.isArray(trackMember) && trackMember.length >= 1);

    const exportRes = await get('/api/export/trade-monitor');
    ok('GET /api/export/trade-monitor → CSV 200', exportRes.ok && /csv/.test(exportRes.headers.get('content-type') || ''));

    console.log('\nWrite path (add → close → delete):');
    const addRes = await fetch(`${BASE}/api/positions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: 'SMOKE', direction: 'long', structure: 'Long Call',
        legs: [{ direction: 'long', option_type: 'call', type: 'call', expiration: '2026-12-18', strike: 100, size: 1, premium: 5, mult: 100 }],
        entry_date: '2026-07-01', net_debit: 500, status: 'open',
      }),
    });
    const added = await addRes.json();
    const newId = added?.position?.id;
    ok('POST /api/positions → created', addRes.ok && Number.isInteger(newId), JSON.stringify(added).slice(0, 120));
    ok('added position appears in book', (await getJSON('/api/positions')).some((p) => p.ticker === 'SMOKE'));

    const closeRes = await fetch(`${BASE}/api/positions/${newId}/close`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ closedQty: 1, exitPrice: 6, exitDate: '2026-07-01', legIndex: 0 }),
    });
    ok('PATCH …/close → 200 (booked to realized)', closeRes.ok);

    const delRes = await fetch(`${BASE}/api/positions/${newId}`, { method: 'DELETE' });
    ok('DELETE /api/positions/:id → 200', delRes.ok);
    ok('position removed from open book', !(await getJSON('/api/positions')).some((p) => p.ticker === 'SMOKE'));

    console.log('\nTradeStation link API (disconnected, no network):');
    const tsStatus = await getJSON('/api/tradestation/status');
    ok('GET /api/tradestation/status → shape', tsStatus && 'connected' in tsStatus && 'needsReconnect' in tsStatus && 'hasCredentials' in tsStatus, JSON.stringify(tsStatus));
    ok('status starts disconnected', tsStatus.connected === false && tsStatus.hasCredentials === false);
    ok('status advertises the callback URL', typeof tsStatus.redirectUri === 'string' && /\/api\/tradestation\/callback$/.test(tsStatus.redirectUri), tsStatus.redirectUri);

    const badCreds = await fetch(`${BASE}/api/tradestation/credentials`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: '', client_secret: '' }),
    });
    ok('POST /credentials with blanks → 400', badCreds.status === 400);

    const goodCreds = await fetch(`${BASE}/api/tradestation/credentials`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: 'KEY', client_secret: 'SECRET', environment: 'sim' }),
    });
    ok('POST /credentials valid → 200', goodCreds.ok);
    ok('status now hasCredentials', (await getJSON('/api/tradestation/status')).hasCredentials === true);

    // Do NOT follow the redirect (that would hit TradeStation's real server);
    // just assert we 302 to their consent host with the OAuth params.
    const connectRedirect = await fetch(`${BASE}/api/tradestation/connect`, { redirect: 'manual' });
    const location = connectRedirect.headers.get('location') || '';
    ok('GET /connect → 302 to TradeStation consent', (connectRedirect.status === 302 || connectRedirect.status === 301) && /signin\.tradestation\.com\/authorize/.test(location) && /response_type=code/.test(location), `${connectRedirect.status} ${location}`);

    // OAuth callback guards (offline: both reject before any network call).
    const cbNoCode = await get('/api/tradestation/callback');
    ok('GET /callback without code → 400', cbNoCode.status === 400);
    const cbBadState = await get('/api/tradestation/callback?code=x&state=NOT_THE_STATE');
    ok('GET /callback with wrong state → 400 (CSRF guard)', cbBadState.status === 400);

    const pfWhileDisconnected = await get('/api/tradestation/portfolio');
    ok('GET /portfolio while disconnected → 409', pfWhileDisconnected.status === 409);

    const disc = await fetch(`${BASE}/api/tradestation/disconnect`, { method: 'POST' });
    ok('POST /disconnect → 200', disc.ok);
  } catch (err) {
    failed++;
    console.error('\nUnexpected error:', err?.stack || err);
    console.error('Server log:\n' + serverLog);
  } finally {
    cleanup();
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
