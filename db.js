// Database adapter. ONE place that touches the database.
//
//   * If DATABASE_URL is set  -> PostgreSQL (Neon, Supabase, Render PG, etc.)
//   * Otherwise               -> local SQLite file (great for testing on your computer)
//
// Both back ends are exposed through the same tiny async interface:
//     await db.get(sql, params)   -> one row (or undefined)
//     await db.all(sql, params)   -> array of rows
//     await db.run(sql, params)   -> { lastInsertRowid, changes }
//     await db.init()             -> creates tables if they don't exist
//
// SQL is written once using "?" placeholders and CURRENT_TIMESTAMP; the adapter
// translates "?" to "$1, $2, ..." for Postgres. Inserts use "RETURNING id".
const path = require('path');

const usePg = !!process.env.DATABASE_URL;

let pool = null;      // postgres
let sqlite = null;    // sqlite

if (usePg) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Managed Postgres (Neon/Supabase/Render) requires SSL.
    ssl: { rejectUnauthorized: false },
  });
} else {
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'sailone_crm.db');
  try {
    const Database = require('better-sqlite3');
    sqlite = new Database(dbPath);
  } catch {
    const { DatabaseSync } = require('node:sqlite');
    sqlite = new DatabaseSync(dbPath);
  }
  try { sqlite.exec('PRAGMA journal_mode = WAL'); } catch { /* unsupported on some mounts */ }
  sqlite.exec('PRAGMA foreign_keys = ON');
}

// turn "... ? ... ?" into "... $1 ... $2" for postgres
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + ++i);
}

async function all(sql, params = []) {
  if (usePg) {
    const r = await pool.query(toPg(sql), params);
    return r.rows;
  }
  return sqlite.prepare(sql).all(...params);
}

async function get(sql, params = []) {
  if (usePg) {
    const r = await pool.query(toPg(sql), params);
    return r.rows[0];
  }
  return sqlite.prepare(sql).get(...params);
}

// For INSERTs, always append "RETURNING id" in the caller so we can read the new id
// on both back ends.
async function run(sql, params = []) {
  if (usePg) {
    const r = await pool.query(toPg(sql), params);
    return {
      lastInsertRowid: r.rows[0] ? r.rows[0].id : undefined,
      changes: r.rowCount,
    };
  }
  const isInsertReturning = /returning/i.test(sql);
  if (isInsertReturning) {
    const row = sqlite.prepare(sql).get(...params);
    return { lastInsertRowid: row ? Number(row.id) : undefined, changes: 1 };
  }
  const info = sqlite.prepare(sql).run(...params);
  return { lastInsertRowid: Number(info.lastInsertRowid), changes: info.changes };
}

// ---- schema (dialect-neutral via a couple of macros) ----
const PK = usePg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const TS = usePg ? 'TIMESTAMP' : 'TEXT';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id ${PK},
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at ${TS} DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS contacts (
  id ${PK},
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company TEXT, email TEXT, phone TEXT, title TEXT, notes TEXT,
  from_lead_id INTEGER,
  created_at ${TS} DEFAULT CURRENT_TIMESTAMP,
  updated_at ${TS} DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS leads (
  id ${PK},
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company TEXT, email TEXT, phone TEXT, source TEXT,
  status TEXT DEFAULT 'new',
  notes TEXT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  created_at ${TS} DEFAULT CURRENT_TIMESTAMP,
  updated_at ${TS} DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS opportunities (
  id ${PK},
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  value REAL DEFAULT 0,
  stage TEXT DEFAULT 'prospecting',
  close_date TEXT, notes TEXT,
  created_at ${TS} DEFAULT CURRENT_TIMESTAMP,
  updated_at ${TS} DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reminders (
  id ${PK},
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  due_at ${TS} NOT NULL,
  sent INTEGER DEFAULT 0,
  created_at ${TS} DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS journeys (
  id ${PK},
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at ${TS} DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS journey_steps (
  id ${PK},
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  day_offset INTEGER NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  step_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS enrollments (
  id ${PK},
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  enrolled_at ${TS} DEFAULT CURRENT_TIMESTAMP,
  active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS enrollment_sends (
  id ${PK},
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  step_id INTEGER NOT NULL REFERENCES journey_steps(id) ON DELETE CASCADE,
  sent_at ${TS} DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id ${PK},
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription TEXT NOT NULL,
  created_at ${TS} DEFAULT CURRENT_TIMESTAMP
);
`;

async function init() {
  if (usePg) {
    await pool.query(SCHEMA); // simple-query protocol runs all statements
  } else {
    sqlite.exec(SCHEMA);
  }
  console.log(`Database ready (${usePg ? 'PostgreSQL' : 'SQLite'}).`);
}

module.exports = { all, get, run, init, usePg };
