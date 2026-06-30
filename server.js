/*
 * server.js — Portfolio Tracker.
 *
 * A small Express app that serves two static pages (Current Portfolio +
 * Realized) and the JSON API they consume. No login, single local user. The
 * SQLite database is created and seeded with demo data automatically on first
 * run, so `npm install && npm start` brings up a fully working app.
 */
const path = require('path');
const express = require('express');

const db = require('./lib/db');
const { ensureSeeded } = require('./db/seed');

// Seed demo data on first boot (no-op once the DB has positions).
ensureSeeded(db);

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// API routes (all under /api).
app.use('/api', require('./routes/positions'));
app.use('/api', require('./routes/track'));
app.use('/api', require('./routes/market'));
app.use('/api', require('./routes/misc'));

// Unmatched API calls → JSON 404 (so the pages' fetch handlers degrade cleanly
// instead of receiving the static index.html). This is also what keeps the
// broker panel hidden: /api/tradestation/* falls through to here.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Static pages + assets (portfolio.html, track-record.html, css/, js/, …).
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Root → the portfolio page.
app.get('/', (req, res) => res.redirect('/portfolio.html'));

// Clean error responses (e.g. malformed JSON body) without leaking a stack trace.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  console.error('[error]', (err && err.message) || err);
  res.status((err && err.status) || 500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n  Portfolio Tracker running`);
  console.log(`  →  http://localhost:${PORT}/portfolio.html   (Current Portfolio)`);
  console.log(`  →  http://localhost:${PORT}/track-record.html (Realized)\n`);
});
