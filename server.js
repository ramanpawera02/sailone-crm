require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = require('./db');
const { sign, requireAuth } = require('./auth');
const { sendPush } = require('./notify');
const { parseEntity } = require('./parse');
const scheduler = require('./scheduler');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// wraps an async route so thrown errors become a clean 500 instead of crashing
const h = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });

function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 3600 * 1000,
  };
}

/* ---------------- AUTH ---------------- */
app.post('/api/register', h(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email, password required' });
  const exists = await db.get('SELECT 1 FROM users WHERE email = ?', [email]);
  if (exists) return res.status(409).json({ error: 'Email already registered' });
  const hash = bcrypt.hashSync(password, 10);
  const { lastInsertRowid } = await db.run(
    'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?) RETURNING id',
    [name, email, hash]
  );
  const user = { id: lastInsertRowid, name, email };
  res.cookie('token', sign(user), cookieOpts()).json({ user });
}));

app.post('/api/login', h(async (req, res) => {
  const { email, password } = req.body;
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });
  res
    .cookie('token', sign(user), cookieOpts())
    .json({ user: { id: user.id, name: user.name, email: user.email } });
}));

app.post('/api/logout', (req, res) => res.clearCookie('token').json({ ok: true }));
app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));

/* ---------------- Generic CRUD ---------------- */
function crud(table, fields) {
  const r = express.Router();
  r.use(requireAuth);

  r.get('/', h(async (req, res) => {
    res.json(await db.all(
      `SELECT * FROM ${table} WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC`,
      [req.user.id]
    ));
  }));

  r.post('/', h(async (req, res) => {
    const cols = fields.filter((f) => req.body[f] !== undefined);
    const placeholders = cols.map(() => '?').join(', ');
    const { lastInsertRowid } = await db.run(
      `INSERT INTO ${table} (user_id${cols.length ? ', ' + cols.join(', ') : ''})
       VALUES (?${cols.length ? ', ' + placeholders : ''}) RETURNING id`,
      [req.user.id, ...cols.map((c) => req.body[c])]
    );
    res.json(await db.get(`SELECT * FROM ${table} WHERE id = ?`, [lastInsertRowid]));
  }));

  r.put('/:id', h(async (req, res) => {
    const cols = fields.filter((f) => req.body[f] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'nothing to update' });
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    await db.run(
      `UPDATE ${table} SET ${setClause}, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [...cols.map((c) => req.body[c]), req.params.id, req.user.id]
    );
    res.json(await db.get(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]));
  }));

  r.delete('/:id', h(async (req, res) => {
    await db.run(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  }));

  return r;
}

app.use('/api/leads', crud('leads', ['name', 'company', 'email', 'phone', 'source', 'status', 'notes', 'contact_id']));
app.use('/api/contacts', crud('contacts', ['name', 'company', 'email', 'phone', 'title', 'notes', 'from_lead_id']));
app.use('/api/opportunities', crud('opportunities', ['contact_id', 'title', 'value', 'stage', 'close_date', 'notes']));

/* ---------------- Voice: parse spoken text into fields for each entity ---------------- */
// Match a spoken contact name to one of this user's contacts (case-insensitive,
// exact-ish or partial). Returns { contact_id, contact_name } or {}.
async function resolveContact(userId, spokenName) {
  if (!spokenName) return {};
  const n = spokenName.trim().toLowerCase();
  const contacts = await db.all('SELECT id, name FROM contacts WHERE user_id = ?', [userId]);
  let hit = contacts.find((c) => (c.name || '').toLowerCase() === n);
  if (!hit) hit = contacts.find((c) => (c.name || '').toLowerCase().includes(n) || n.includes((c.name || '').toLowerCase()));
  return hit ? { contact_id: hit.id, contact_name: hit.name } : { contact_name: spokenName };
}

app.post('/api/leads/parse', requireAuth, h(async (req, res) => {
  res.json(await parseEntity('lead', req.body.transcript || '', { now: req.body.now }));
}));

app.post('/api/contacts/parse', requireAuth, h(async (req, res) => {
  res.json(await parseEntity('contact', req.body.transcript || '', { now: req.body.now }));
}));

app.post('/api/opportunities/parse', requireAuth, h(async (req, res) => {
  const f = await parseEntity('opportunity', req.body.transcript || '', { now: req.body.now });
  Object.assign(f, await resolveContact(req.user.id, f.contact_name));
  res.json(f);
}));

app.post('/api/reminders/parse', requireAuth, h(async (req, res) => {
  const f = await parseEntity('reminder', req.body.transcript || '', { now: req.body.now });
  Object.assign(f, await resolveContact(req.user.id, f.contact_name));
  res.json(f);
}));

/* ---------------- Convert: Lead -> Contact (+ optional Opportunity) ---------------- */
app.post('/api/leads/:id/convert', requireAuth, h(async (req, res) => {
  const lead = await db.get('SELECT * FROM leads WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const { lastInsertRowid: contactId } = await db.run(
    `INSERT INTO contacts (user_id, name, company, email, phone, notes, from_lead_id)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [req.user.id, lead.name, lead.company, lead.email, lead.phone, lead.notes, lead.id]
  );

  await db.run(
    `UPDATE leads SET status='converted', contact_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [contactId, lead.id]
  );

  let opportunity = null;
  if (req.body.createOpportunity) {
    const { lastInsertRowid: oid } = await db.run(
      `INSERT INTO opportunities (user_id, contact_id, title, value, stage)
       VALUES (?, ?, ?, ?, 'prospecting') RETURNING id`,
      [req.user.id, contactId, req.body.opportunityTitle || `${lead.name} opportunity`, req.body.value || 0]
    );
    opportunity = await db.get('SELECT * FROM opportunities WHERE id = ?', [oid]);
  }

  res.json({
    contact: await db.get('SELECT * FROM contacts WHERE id = ?', [contactId]),
    opportunity,
  });
}));

/* ---------------- Reminders ---------------- */
app.get('/api/reminders', requireAuth, h(async (req, res) => {
  res.json(await db.all('SELECT * FROM reminders WHERE user_id = ? ORDER BY due_at', [req.user.id]));
}));
app.post('/api/reminders', requireAuth, h(async (req, res) => {
  const { contact_id, channel, title, body, due_at } = req.body;
  const { lastInsertRowid } = await db.run(
    `INSERT INTO reminders (user_id, contact_id, channel, title, body, due_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    [req.user.id, contact_id || null, channel || 'push', title, body || '', due_at]
  );
  res.json(await db.get('SELECT * FROM reminders WHERE id = ?', [lastInsertRowid]));
}));
app.delete('/api/reminders/:id', requireAuth, h(async (req, res) => {
  await db.run('DELETE FROM reminders WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

/* ---------------- Journeys ---------------- */
app.get('/api/journeys', requireAuth, h(async (req, res) => {
  const journeys = await db.all('SELECT * FROM journeys WHERE user_id = ?', [req.user.id]);
  for (const j of journeys) {
    j.steps = await db.all(
      'SELECT * FROM journey_steps WHERE journey_id = ? ORDER BY day_offset, step_order',
      [j.id]
    );
  }
  res.json(journeys);
}));

app.post('/api/journeys', requireAuth, h(async (req, res) => {
  const { name, steps } = req.body;
  const { lastInsertRowid: jid } = await db.run(
    'INSERT INTO journeys (user_id, name) VALUES (?, ?) RETURNING id',
    [req.user.id, name]
  );
  let i = 0;
  for (const s of steps || []) {
    await db.run(
      `INSERT INTO journey_steps (journey_id, day_offset, subject, body, step_order)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [jid, s.day_offset || 0, s.subject, s.body, i++]
    );
  }
  res.json({ id: jid });
}));

app.delete('/api/journeys/:id', requireAuth, h(async (req, res) => {
  await db.run('DELETE FROM journeys WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

app.post('/api/journeys/:id/enroll', requireAuth, h(async (req, res) => {
  const { lastInsertRowid } = await db.run(
    'INSERT INTO enrollments (user_id, journey_id, contact_id) VALUES (?, ?, ?) RETURNING id',
    [req.user.id, req.params.id, req.body.contact_id]
  );
  res.json({ id: lastInsertRowid });
}));

/* ---------------- Web Push ---------------- */
app.get('/api/push/key', (req, res) => res.json({ key: process.env.VAPID_PUBLIC_KEY || '' }));
app.post('/api/push/subscribe', requireAuth, h(async (req, res) => {
  await db.run('INSERT INTO push_subscriptions (user_id, subscription) VALUES (?, ?) RETURNING id',
    [req.user.id, JSON.stringify(req.body)]);
  res.json({ ok: true });
}));
app.post('/api/push/test', requireAuth, h(async (req, res) => {
  const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', [req.user.id]);
  for (const s of subs) await sendPush(s.subscription, { title: 'SailOne CRM', body: 'Test notification ✅' });
  res.json({ ok: true, devices: subs.length });
}));

/* ---------------- Stats ---------------- */
app.get('/api/stats', requireAuth, h(async (req, res) => {
  const n = async (sql) => (await db.get(sql, [req.user.id])).n;
  res.json({
    leads: await n('SELECT COUNT(*) n FROM leads WHERE user_id = ?'),
    contacts: await n('SELECT COUNT(*) n FROM contacts WHERE user_id = ?'),
    opportunities: await n('SELECT COUNT(*) n FROM opportunities WHERE user_id = ?'),
    pipeline: await n("SELECT COALESCE(SUM(value),0) n FROM opportunities WHERE user_id = ? AND stage NOT IN ('won','lost')"),
  });
}));

const PORT = process.env.PORT || 3000;
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`SailOne CRM running at http://localhost:${PORT}`);
    scheduler.start();
  });
}).catch((e) => {
  console.error('Failed to start: database error', e);
  process.exit(1);
});
