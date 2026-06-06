// Background worker: runs every minute.
//  1. Fires due reminders (email to customer, or push to your phone).
//  2. Advances customer journeys (sends the next due drip email).
// Date math for journeys is done in JavaScript so it works on both Postgres and SQLite.
const db = require('./db');
const { sendEmail, sendPush } = require('./notify');

const DAY_MS = 24 * 60 * 60 * 1000;

// Normalize a timestamp from either back end (PG Date object or SQLite text) to ms.
function toMs(ts) {
  if (ts instanceof Date) return ts.getTime();
  return Date.parse(String(ts).replace(' ', 'T') + 'Z');
}

async function processReminders() {
  const due = await db.all(
    `SELECT * FROM reminders WHERE sent = 0 AND due_at <= CURRENT_TIMESTAMP`
  );
  for (const r of due) {
    try {
      if (r.channel === 'email' && r.contact_id) {
        const c = await db.get('SELECT * FROM contacts WHERE id = ?', [r.contact_id]);
        if (c && c.email) await sendEmail(c.email, r.title, r.body || '');
      } else {
        const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', [r.user_id]);
        for (const s of subs) await sendPush(s.subscription, { title: r.title, body: r.body || '' });
      }
      await db.run('UPDATE reminders SET sent = 1 WHERE id = ?', [r.id]);
    } catch (e) {
      console.error('reminder error', r.id, e.message);
    }
  }
}

function personalize(text, contact) {
  return (text || '')
    .replace(/\{\{name\}\}/g, contact.name || 'there')
    .replace(/\{\{company\}\}/g, contact.company || 'your company');
}

async function processJourneys() {
  const active = await db.all('SELECT * FROM enrollments WHERE active = 1');
  for (const en of active) {
    const steps = await db.all(
      'SELECT * FROM journey_steps WHERE journey_id = ? ORDER BY day_offset, step_order',
      [en.journey_id]
    );
    const contact = await db.get('SELECT * FROM contacts WHERE id = ?', [en.contact_id]);
    if (!contact || !contact.email) continue;

    const enrolledMs = toMs(en.enrolled_at);

    for (const step of steps) {
      const already = await db.get(
        'SELECT 1 FROM enrollment_sends WHERE enrollment_id = ? AND step_id = ?',
        [en.id, step.id]
      );
      if (already) continue;

      const dueMs = enrolledMs + step.day_offset * DAY_MS;
      if (Date.now() < dueMs) continue; // not time yet

      try {
        await sendEmail(
          contact.email,
          personalize(step.subject, contact),
          personalize(step.body, contact)
        );
        await db.run(
          'INSERT INTO enrollment_sends (enrollment_id, step_id) VALUES (?, ?) RETURNING id',
          [en.id, step.id]
        );
      } catch (e) {
        console.error('journey send error', en.id, step.id, e.message);
      }
    }

    // deactivate when every step has been sent
    const total = steps.length;
    const sent = (await db.get(
      'SELECT COUNT(*) n FROM enrollment_sends WHERE enrollment_id = ?',
      [en.id]
    )).n;
    if (total > 0 && Number(sent) >= total) {
      await db.run('UPDATE enrollments SET active = 0 WHERE id = ?', [en.id]);
    }
  }
}

function start() {
  const tick = async () => {
    try {
      await processReminders();
      await processJourneys();
    } catch (e) {
      console.error('scheduler tick error', e.message);
    }
  };
  tick();
  setInterval(tick, 60 * 1000);
  console.log('Scheduler running (reminders + journeys, 60s interval).');
}

module.exports = { start };
