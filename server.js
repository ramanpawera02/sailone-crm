require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = require('./db');
const { sign, requireAuth } = require('./auth');
const { sendEmail, sendPush } = require('./notify');
const scheduler = require('./scheduler');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const now = () => "datetime('now')";

/* ---------------- AUTH ---------------- */
app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email, password required' });
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'Email already registered' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name, email, hash);
  const user = { id: info.lastInsertRowid, name, email };
  res.cookie('token', sign(user), cookieOpts()).json({ user });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });
  res
    .cookie('token', sign(user), cookieOpts())
    .json({ user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token').json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));

function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 3600 * 1000,
  };
}

/* ---------------- Generic CRUD helper ---------------- */
function crud(table, fields) {
  const r = express.Router();
  r.use(requireAuth);

  r.get('/', (req, res) => {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC`)
      .all(req.user.id);
    res.json(rows);
  });

  r.post('/', (req, res) => {
    const cols = fields.filter((f) => req.body[f] !== undefined);
    const placeholders = cols.map(() => '?').join(', ');
    const stmt = db.prepare(
      `INSERT INTO ${table} (user_id${cols.length ? ', ' + cols.join(', ') : ''})
       VALUES (?${cols.length ? ', ' + placeholders : ''})`
    );
    const info = stmt.run(req.user.id, ...cols.map((c) => req.body[c]));
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid));
  });

  r.put('/:id', (req, res) => {
    const cols = fields.filter((f) => req.body[f] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'nothing to update' });
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    db.prepare(
      `UPDATE ${table} SET ${setClause}, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    ).run(...cols.map((c) => req.body[c]), req.params.id, req.user.id);
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id));
  });

  r.delete('/:id', (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).run(
      req.params.id,
      req.user.id
    );
    res.json({ ok: true });
  });

  return r;
}

app.use('/api/leads', crud('leads', ['name', 'company', 'email', 'phone', 'source', 'status', 'notes', 'contact_id']));
app.use('/api/contacts', crud('contacts', ['name', 'company', 'email', 'phone', 'title', 'notes', 'from_lead_id']));
app.use('/api/opportunities', crud('opportunities', ['contact_id', 'title', 'value', 'stage', 'close_date', 'notes']));

/* ---------------- Conversion flow: Lead -> Contact ---------------- */
app.post('/api/leads/:id/convert', requireAuth, (req, res) => {
  const lead = db
    .prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const info = db
    .prepare(
      `INSERT INTO contacts (user_id, name, company, email, phone, notes, from_lead_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, lead.name, lead.company, lead.email, lead.phone, lead.notes, lead.id);
  const contactId = info.lastInsertRowid;

  db.prepare(`UPDATE leads SET status='converted', contact_id=?, updated_at=datetime('now') WHERE id=?`)
    .run(contactId, lead.id);

  // optionally spin up an opportunity at the same time
  let opportunity = null;
  if (req.body.createOpportunity) {
    const oi = db
      .prepare(
        `INSERT INTO opportunities (user_id, contact_id, title, value, stage)
         VALUES (?, ?, ?, ?, 'prospecting')`
      )
      .run(req.user.id, contactId, req.body.opportunityTitle || `${lead.name} opportunity`, req.body.value || 0);
    opportunity = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(oi.lastInsertRowid);
  }

  res.json({
    contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId),
    opportunity,
  });
});

/* ---------------- Reminders ---------------- */
app.get('/api/reminders', requireAuth, (req, res) => {
  res.json(
    db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY due_at').all(req.user.id)
  );
});
app.post('/api/reminders', requireAuth, (req, res) => {
  const { contact_id, channel, title, body, due_at } = req.body;
  const info = db
    .prepare(
      `INSERT INTO reminders (user_id, contact_id, channel, title, body, due_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, contact_id || null, channel || 'push', title, body || '', due_at);
  res.json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(info.lastInsertRowid));
});
app.delete('/api/reminders/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

/* ---------------- Journeys (customer drip sequences) ---------------- */
app.get('/api/journeys', requireAuth, (req, res) => {
  const journeys = db.prepare('SELECT * FROM journeys WHERE user_id = ?').all(req.user.id);
  for (const j of journeys) {
    j.steps = db
      .prepare('SELECT * FROM journey_steps WHERE journey_id = ? ORDER BY day_offset, step_order')
      .all(j.id);
  }
  res.json(journeys);
});

app.post('/api/journeys', requireAuth, (req, res) => {
  const { name, steps } = req.body;
  const info = db.prepare('INSERT INTO journeys (user_id, name) VALUES (?, ?)').run(req.user.id, name);
  const jid = info.lastInsertRowid;
  (steps || []).forEach((s, i) => {
    db.prepare(
      `INSERT INTO journey_steps (journey_id, day_offset, subject, body, step_order)
       VALUES (?, ?, ?, ?, ?)`
    ).run(jid, s.day_offset || 0, s.subject, s.body, i);
  });
  res.json({ id: jid });
});

app.delete('/api/journeys/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM journeys WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/journeys/:id/enroll', requireAuth, (req, res) => {
  const { contact_id } = req.body;
  const info = db
    .prepare('INSERT INTO enrollments (user_id, journey_id, contact_id) VALUES (?, ?, ?)')
    .run(req.user.id, req.params.id, contact_id);
  res.json({ id: info.lastInsertRowid });
});

/* ---------------- Web Push subscription ---------------- */
app.get('/api/push/key', (req, res) => res.json({ key: process.env.VAPID_PUBLIC_KEY || '' }));
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  db.prepare('INSERT INTO push_subscriptions (user_id, subscription) VALUES (?, ?)').run(
    req.user.id,
    JSON.stringify(req.body)
  );
  res.json({ ok: true });
});
app.post('/api/push/test', requireAuth, async (req, res) => {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(req.user.id);
  for (const s of subs) await sendPush(s.subscription, { title: 'SailOne CRM', body: 'Test notification ✅' });
  res.json({ ok: true, devices: subs.length });
});

/* ---------------- Dashboard stats ---------------- */
app.get('/api/stats', requireAuth, (req, res) => {
  const one = (sql) => db.prepare(sql).get(req.user.id).n;
  res.json({
    leads: one('SELECT COUNT(*) n FROM leads WHERE user_id = ?'),
    contacts: one('SELECT COUNT(*) n FROM contacts WHERE user_id = ?'),
    opportunities: one('SELECT COUNT(*) n FROM opportunities WHERE user_id = ?'),
    pipeline: db.prepare(
      "SELECT COALESCE(SUM(value),0) n FROM opportunities WHERE user_id = ? AND stage NOT IN ('won','lost')"
    ).get(req.user.id).n,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SailOne CRM running at http://localhost:${PORT}`);
  scheduler.start();
});
