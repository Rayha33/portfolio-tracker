/*
 * db.js — SQLite connection + schema bootstrap.
 *
 * One file holds the whole portfolio: open positions, closed positions, the
 * realized track record, and a small quote cache. The schema is applied
 * idempotently on every boot (CREATE TABLE IF NOT EXISTS), so a fresh clone
 * comes up with a valid database with zero manual steps.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH =
  process.env.PORTFOLIO_DB_PATH || path.join(__dirname, '..', 'db', 'portfolio.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Pragmas: concurrent readers (WAL), durable-enough writes, sane waits.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Apply schema (idempotent).
const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
db.exec(schema);

process.on('exit', () => {
  try {
    db.close();
  } catch (e) {
    /* already closed */
  }
});

module.exports = db;
module.exports.DB_PATH = DB_PATH;
