// Database setup + schema. File-based SQLite, zero-config.
// Prefers better-sqlite3 if installed; otherwise falls back to Node's
// built-in node:sqlite (no native build needed). Both expose the same
// .exec()/.prepare().run()/.get()/.all() interface used by this app.
// To switch to Postgres later, this is the only file you need to swap.
const path = require('path');
const dbPath = process.env.DB_PATH || path.join(__dirname, 'sailone_crm.db');

let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(dbPath);
} catch {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(dbPath);
}

// WAL improves concurrency but isn't supported on some network/fuse mounts.
try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* fall back to default journal */ }
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Standard CRM flow: Lead -> Contact -> Opportunity
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  source TEXT,
  status TEXT DEFAULT 'new',        -- new | working | qualified | converted | lost
  notes TEXT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  title TEXT,
  notes TEXT,
  from_lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  value REAL DEFAULT 0,
  stage TEXT DEFAULT 'prospecting', -- prospecting | proposal | negotiation | won | lost
  close_date TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Reminders: email to customer, or push to your phone to call/email them
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,            -- 'push' (your phone) | 'email' (to customer)
  title TEXT NOT NULL,
  body TEXT,
  due_at TEXT NOT NULL,
  sent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Customer journeys = reusable drip sequences of email steps
CREATE TABLE IF NOT EXISTS journeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journey_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  day_offset INTEGER NOT NULL,      -- send N days after enrollment
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  step_order INTEGER DEFAULT 0
);

-- A contact enrolled in a journey
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  enrolled_at TEXT DEFAULT (datetime('now')),
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS enrollment_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  step_id INTEGER NOT NULL REFERENCES journey_steps(id) ON DELETE CASCADE,
  sent_at TEXT DEFAULT (datetime('now'))
);

-- Web push subscriptions (your devices)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

module.exports = db;
