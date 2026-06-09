// Exercises the async DB adapter end-to-end (SQLite path). The SQL and code paths
// are identical to what Postgres uses, so this validates the conversion logic.
const db = require('./db');
const bcrypt = require('bcryptjs');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS', m)) : (fail++, console.log('  FAIL', m)); };

(async () => {
  await db.init();

  // 1. user + password security
  const hash = bcrypt.hashSync('test123', 10);
  const u = await db.run('INSERT INTO users(name,email,password_hash) VALUES(?,?,?) RETURNING id', ['Raman', 'raman@sailone.ai', hash]);
  const uid = u.lastInsertRowid;
  ok(uid > 0, 'user insert returns id (RETURNING works)');
  ok(bcrypt.compareSync('test123', hash) && !bcrypt.compareSync('x', hash), 'password hashing verifies');

  // 2. lead
  const l = await db.run('INSERT INTO leads(user_id,name,company,email) VALUES(?,?,?,?) RETURNING id', [uid, 'Acme Corp', 'Acme', 'buy@acme.com']);
  const lid = l.lastInsertRowid;
  ok((await db.get('SELECT status FROM leads WHERE id=?', [lid])).status === 'new', 'lead default status=new');

  // 3. convert lead -> contact + opportunity
  const c = await db.run('INSERT INTO contacts(user_id,name,company,email,from_lead_id) VALUES(?,?,?,?,?) RETURNING id', [uid, 'Acme Corp', 'Acme', 'buy@acme.com', lid]);
  const cid = c.lastInsertRowid;
  await db.run("UPDATE leads SET status='converted',contact_id=? WHERE id=?", [cid, lid]);
  await db.run("INSERT INTO opportunities(user_id,contact_id,title,value,stage) VALUES(?,?,?,?,'prospecting') RETURNING id", [uid, cid, 'Acme deal', 5000]);
  const lead = await db.get('SELECT * FROM leads WHERE id=?', [lid]);
  ok(lead.contact_id === cid && lead.status === 'converted', 'lead converted + linked to contact');
  ok((await db.get('SELECT value FROM opportunities WHERE contact_id=?', [cid])).value === 5000, 'opportunity created with value');

  // 4. journey + steps
  const j = await db.run('INSERT INTO journeys(user_id,name) VALUES(?,?) RETURNING id', [uid, 'Welcome']);
  const jid = j.lastInsertRowid;
  await db.run('INSERT INTO journey_steps(journey_id,day_offset,subject,body,step_order) VALUES(?,?,?,?,?) RETURNING id', [jid, 0, 'Hi {{name}}', 'Welcome', 0]);
  await db.run('INSERT INTO journey_steps(journey_id,day_offset,subject,body,step_order) VALUES(?,?,?,?,?) RETURNING id', [jid, 3, 'Follow up', 'Hello {{company}}', 1]);
  ok((await db.get('SELECT COUNT(*) n FROM journey_steps WHERE journey_id=?', [jid])).n == 2, 'journey created with 2 steps');

  // 5. reminder
  await db.run('INSERT INTO reminders(user_id,contact_id,channel,title,due_at) VALUES(?,?,?,?,?) RETURNING id', [uid, cid, 'push', 'Call Acme', '2026-01-01 09:00:00']);
  ok((await db.get('SELECT sent FROM reminders WHERE user_id=?', [uid])).sent == 0, 'reminder queued (unsent)');

  // 6. stats (mirrors /stats)
  const leads = (await db.get('SELECT COUNT(*) n FROM leads WHERE user_id=?', [uid])).n;
  const pipeline = (await db.get("SELECT COALESCE(SUM(value),0) n FROM opportunities WHERE user_id=? AND stage NOT IN ('won','lost')", [uid])).n;
  ok(leads == 1 && pipeline == 5000, 'dashboard stats compute (pipeline=$5000)');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
