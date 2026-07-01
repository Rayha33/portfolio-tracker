/**
 * Unit tests for the optional TradeStation link (lib/tradestation.js).
 *
 * These exercise the pure mappers (option-symbol parsing, position → row,
 * balance normalization) and the DB-backed config/OAuth-URL logic against a
 * throwaway SQLite database. No network is touched.
 *
 * Run with:  node test/tradestation.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// Point the DB at a throwaway file BEFORE the lib (which opens the DB on
// require) is loaded, and give the redirect a deterministic base URL.
const DB = path.join(os.tmpdir(), `pt-ts-unit-${process.pid}-${Date.now()}.db`);
process.env.PORTFOLIO_DB_PATH = DB;
process.env.APP_BASE_URL = 'http://localhost:3000';

const require = createRequire(import.meta.url);
const ts = require('../lib/tradestation.js');

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name, a, b) => ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
function threw(fn) { try { fn(); return false; } catch { return true; } }

function cleanup() {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + ext); } catch {} }
}

try {
  console.log('\nparseOptionSymbol:');
  const a = ts.parseOptionSymbol('AAPL 260918C200');
  ok('native call parses', a && a.underlying === 'AAPL' && a.option_type === 'call' && a.strike === 200 && a.expiration === '2026-09-18', JSON.stringify(a));
  const p = ts.parseOptionSymbol('SPY 251219P475.5');
  ok('decimal put parses', p && p.option_type === 'put' && p.strike === 475.5 && p.expiration === '2025-12-19', JSON.stringify(p));
  const osi = ts.parseOptionSymbol('AAPL 260918C00200000');
  ok('OSI 8-digit strike ÷1000', osi && osi.strike === 200, JSON.stringify(osi));
  const brk = ts.parseOptionSymbol('BRK.B 261218C500');
  ok('dotted underlying parses', brk && brk.underlying === 'BRK.B' && brk.strike === 500, JSON.stringify(brk));
  eq('plain equity symbol → null', ts.parseOptionSymbol('AAPL'), null);
  eq('empty → null', ts.parseOptionSymbol(''), null);

  console.log('\ntsPositionToRow:');
  const longCall = ts.tsPositionToRow({ Symbol: 'MSFT 261016C480', AssetType: 'STOCKOPTION', LongShort: 'Long', Quantity: '4', AveragePrice: '24.5', Timestamp: '2026-05-02T14:00:00Z' }, '1');
  const lcLeg = JSON.parse(longCall.legs_json)[0];
  ok('long call → correct row', longCall.ticker === 'MSFT' && longCall.direction === 'long' && longCall.structure === 'Long Call' && longCall.status === 'open' && longCall.source_idea === 'TradeStation' && longCall.entry_date === '2026-05-02', JSON.stringify(longCall));
  ok('long call → leg + net_debit', lcLeg.option_type === 'call' && lcLeg.strike === 480 && lcLeg.expiration === '2026-10-16' && lcLeg.size === 4 && lcLeg.premium === 24.5 && lcLeg.mult === 100 && longCall.net_debit === 9800, `${longCall.net_debit} ${JSON.stringify(lcLeg)}`);

  const shortPut = ts.tsPositionToRow({ Symbol: 'TSLA 261016P300', AssetType: 'STOCKOPTION', LongShort: 'Short', Quantity: '5', AveragePrice: '27' }, '1');
  ok('short put → short + negative net_debit (credit)', shortPut.direction === 'short' && shortPut.structure === 'Short Put' && shortPut.net_debit === -13500, `${shortPut.net_debit}`);

  const negQtyShort = ts.tsPositionToRow({ Symbol: 'NVDA 261120C150', LongShort: '', Quantity: '-10', AveragePrice: '18.2' }, '1');
  ok('negative quantity infers short', negQtyShort.direction === 'short' && JSON.parse(negQtyShort.legs_json)[0].size === 10, JSON.stringify(negQtyShort));

  eq('equity/stock symbol → null (skipped, not mislabeled)', ts.tsPositionToRow({ Symbol: 'AAPL', AssetType: 'STOCK', LongShort: 'Long', Quantity: '100', AveragePrice: '190' }, '1'), null);
  eq('zero quantity → null', ts.tsPositionToRow({ Symbol: 'AAPL 261016C300', Quantity: '0' }, '1'), null);
  eq('no symbol → null', ts.tsPositionToRow({ Quantity: '1' }, '1'), null);
  ok('isOptionPosition true for option, false for stock', ts.isOptionPosition({ Symbol: 'AAPL 261016C300', Quantity: '1' }) === true && ts.isOptionPosition({ Symbol: 'AAPL', Quantity: '100' }) === false);

  console.log('\nnormalizeBalances:');
  const bal = ts.normalizeBalances([
    { Equity: '1000', CashBalance: '200', TodaysProfitLoss: '50', BalanceDetail: { UnrealizedProfitLoss: '30' } },
    { Equity: '500', CashBalance: '100', TodaysProfitLoss: '-10', BalanceDetail: { UnrealizedProfitLoss: '5' } },
  ]);
  ok('sums across accounts', bal.equity === 1500 && bal.cash === 300 && bal.todaysPl === 40 && bal.unrealizedPl === 35, JSON.stringify(bal));
  const balEmpty = ts.normalizeBalances([]);
  ok('empty → all null', balEmpty.equity === null && balEmpty.cash === null, JSON.stringify(balEmpty));

  console.log('\ncredentials + status + authorize URL:');
  ok('empty client_id throws', threw(() => ts.saveCredentials({ client_id: '', client_secret: 'x', environment: 'sim' })));
  ok('empty secret throws', threw(() => ts.saveCredentials({ client_id: 'x', client_secret: '', environment: 'sim' })));
  ts.saveCredentials({ client_id: 'MYKEY', client_secret: 'MYSECRET', environment: 'live' });
  let st = ts.status();
  ok('after save: hasCredentials + env + not connected', st.hasCredentials === true && st.environment === 'live' && st.connected === false && st.needsReconnect === false, JSON.stringify(st));
  ok('status exposes callback redirect URI', st.redirectUri === 'http://localhost:3000/api/tradestation/callback', st.redirectUri);

  const url = new URL(ts.authorizeUrl('STATE123'));
  ok('authorize URL host + path', url.host === 'signin.tradestation.com' && url.pathname === '/authorize');
  ok('authorize URL params', url.searchParams.get('response_type') === 'code' && url.searchParams.get('client_id') === 'MYKEY' && url.searchParams.get('state') === 'STATE123' && url.searchParams.get('audience') === 'https://api.tradestation.com' && url.searchParams.get('redirect_uri') === 'http://localhost:3000/api/tradestation/callback', url.search);
  ok('authorize URL requests offline_access', (url.searchParams.get('scope') || '').includes('offline_access') && (url.searchParams.get('scope') || '').includes('ReadAccount'));
  ok('authorize persisted the state nonce', ts.getConfig().oauth_state === 'STATE123');

  ts.disconnect();
  st = ts.status();
  ok('disconnect clears connection, keeps credentials', st.connected === false && st.hasCredentials === true, JSON.stringify(st));

  console.log('\nsyncOpenPositions (offline, stubbed fetch):');
  const Database = require('better-sqlite3');
  const rawdb = new Database(DB);
  const insPos = rawdb.prepare(
    `INSERT INTO positions (ticker,direction,structure,legs_json,entry_date,net_debit,status,source_idea,user_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?, 'open', ?, '1', datetime('now'), datetime('now'))`
  );
  const legJson = JSON.stringify([{ direction: 'long', option_type: 'call', type: 'call', expiration: '2026-12-18', strike: 100, size: 1, premium: 5, mult: 100 }]);
  insPos.run('MANUAL', 'long', 'Long Call', legJson, '2026-06-01', 500, null); // hand-entered
  insPos.run('OLDTS', 'long', 'Long Call', legJson, '2026-06-01', 500, 'TradeStation'); // a prior synced row
  const openTickers = () => rawdb.prepare("SELECT ticker FROM positions WHERE user_id='1' AND status='open' ORDER BY ticker").all().map((r) => r.ticker);

  const realFetch = globalThis.fetch;
  const mock = (positionsResponse) => async (url) => {
    const u = String(url);
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (u.includes('/oauth/token')) return reply(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 1200 });
    if (u.endsWith('/brokerage/accounts')) return reply(200, { Accounts: [{ AccountID: 'ACC1', Status: 'Active' }] });
    if (u.includes('/balances')) return reply(200, { Balances: [{ Equity: '1000', CashBalance: '200', TodaysProfitLoss: '10', BalanceDetail: { UnrealizedProfitLoss: '5' } }] });
    if (u.includes('/positions')) return reply(200, positionsResponse);
    return reply(404, { error: 'no route' });
  };

  try {
    ts.saveCredentials({ client_id: 'K', client_secret: 'S', environment: 'sim' });
    globalThis.fetch = mock({ Positions: [] });
    await ts.installRefreshToken('RT');

    // Failure path: a 200-with-Errors soft failure must NOT wipe the open book.
    globalThis.fetch = mock({ Positions: [], Errors: [{ AccountID: 'ACC1', Message: 'account temporarily unavailable' }] });
    let threwOnErrors = false;
    try { await ts.syncOpenPositions(); } catch { threwOnErrors = true; }
    ok('sync throws on 200-with-Errors soft failure', threwOnErrors);
    ok('soft failure preserves the whole open book (no wipe)', JSON.stringify(openTickers()) === JSON.stringify(['MANUAL', 'OLDTS']), JSON.stringify(openTickers()));
    ok('soft failure records last_error', !!ts.getConfig().last_error);

    // Happy path: replace only the TradeStation sleeve; keep the manual row.
    globalThis.fetch = mock({ Positions: [
      { Symbol: 'ZOP 261218C100', AssetType: 'STOCKOPTION', LongShort: 'Long', Quantity: '2', AveragePrice: '5', Timestamp: '2026-06-01T10:00:00Z' },
      { Symbol: 'ZEQ', AssetType: 'STOCK', LongShort: 'Long', Quantity: '10', AveragePrice: '50' },
    ] });
    const res = await ts.syncOpenPositions();
    const after = openTickers();
    ok('happy sync returns ok + counts skipped equity', res.ok === true && res.positions === 1 && res.skippedEquity === 1, JSON.stringify(res));
    ok('manual row preserved, TS sleeve replaced (OLDTS gone, ZOP in)', JSON.stringify(after) === JSON.stringify(['MANUAL', 'ZOP']), JSON.stringify(after));
    ok('happy sync clears last_error + caches balances', ts.getConfig().last_error === null && !!ts.getConfig().last_balances_json);
  } finally {
    globalThis.fetch = realFetch;
    rawdb.close();
  }
} catch (err) {
  failed++;
  console.error('\nUnexpected error:', err?.stack || err);
} finally {
  cleanup();
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
