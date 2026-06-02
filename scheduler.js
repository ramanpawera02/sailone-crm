// Background worker: runs every minute.
//  1. Fires due reminders (email to customer, or push to your phone).
//  2. Advances customer journeys (sends the next due drip email).
const db = require('./db');
const { sendEmail, sendPush } = require('./notify');

async function processReminders() {
  const due = db
    .prepare(`SELECT * FROM reminders WHERE sent = 0 AND due_at <= datetime('now')`)
    .all();
  for (const r of due) {
    try {
      if (r.channel === 'email' && r.contact_id) {
        const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.contact_id);
        if (c?.email) await sendEmail(c.email, r.title, r.body || '');
      } else {
        // push to all of this user's devices
        const subs = db
          .prepare('SELECT * FROM push_subscriptions WHERE user_id = ?')
          .all(r.user_id);
        for (const s of subs) {
          await sendPush(s.subscription, { title: r.title, body: r.body || '' });
        }
      }
      db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(r.id);
    } catch (e) {
      console.error('reminder error', r.id, e.message);
    }
  }
}

async function processJourneys() {
  const active = db.prepare('SELECT * FROM enrollments WHERE active = 1').all();
  for (const en of active) {
    const steps = db
      .prepare('SELECT * FROM journey_steps WHERE journey_id = ? ORDER BY day_offset, step_order')
      .all(en.journey_id);
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(en.contact_id);
    if (!contact?.email) continue;

    for (const step of steps) {
      const alreadySent = db
        .prepare('SELECT 1 FROM enrollment_sends WHERE enrollment_id = ? AND step_id = ?')
        .get(en.id, step.id);
      if (alreadySent) continue;

      // is this step due? (enrolled_at + day_offset days <= now)
      const dueRow = db
        .prepare(
          `SELECT (datetime(?, '+' || ? || ' days') <= datetime('now')) AS due`
        )
        .get(en.enrolled_at, step.day_offset);
      if (!dueRow.due) continue;

      try {
        const subject = personalize(step.subject, contact);
        const body = personalize(step.body, contact);
        await sendEmail(contact.email, subject, body);
        db.prepare('INSERT INTO enrollment_sends (enrollment_id, step_id) VALUES (?, ?)').run(
          en.id,
          step.id
        );
      } catch (e) {
        console.error('journey send error', en.id, step.id, e.message);
      }
    }

    // deactivate if all steps sent
    const total = steps.length;
    const sent = db
      .prepare('SELECT COUNT(*) AS n FROM enrollment_sends WHERE enrollment_id = ?')
      .get(en.id).n;
    if (total > 0 && sent >= total) {
      db.prepare('UPDATE enrollments SET active = 0 WHERE id = ?').run(en.id);
    }
  }
}

function personalize(text, contact) {
  return (text || '')
    .replace(/\{\{name\}\}/g, contact.name || 'there')
    .replace(/\{\{company\}\}/g, contact.company || 'your company');
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
  setInterval(tick, 60 * 1000); // every minute
  console.log('Scheduler running (reminders + journeys, 60s interval).');
}

module.exports = { start };
