const db = require('./db');          // real schema + node:sqlite fallback
const bcrypt = require('bcryptjs');
let jwt = null; try { jwt = require('jsonwebtoken'); } catch {}
const S = 'secret';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS', m)) : (fail++, console.log('  FAIL', m)); };

// 1. user + password security
const hash = bcrypt.hashSync('test123', 10);
const u = db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run('Raman', 'raman@sailone.ai', hash);
const uid = Number(u.lastInsertRowid);
ok(bcrypt.compareSync('test123', hash) && !bcrypt.compareSync('wrong', hash), 'password hashing verifies correctly');
if (jwt) { const tok = jwt.sign({ id: uid }, S); ok(jwt.verify(tok, S).id === uid, 'JWT sign/verify round-trip'); }
else console.log('  SKIP JWT test (jsonwebtoken dep not installed in sandbox)');

// 2. lead
const l = db.prepare('INSERT INTO leads(user_id,name,company,email) VALUES(?,?,?,?)').run(uid, 'Acme Corp', 'Acme', 'buy@acme.com');
const lid = Number(l.lastInsertRowid);
ok(db.prepare('SELECT status FROM leads WHERE id=?').get(lid).status === 'new', 'lead created with default status=new');

// 3. convert lead -> contact (+opportunity), mirrors /convert route
const c = db.prepare('INSERT INTO contacts(user_id,name,company,email,from_lead_id) VALUES(?,?,?,?,?)').run(uid, 'Acme Corp', 'Acme', 'buy@acme.com', lid);
const cid = Number(c.lastInsertRowid);
db.prepare("UPDATE leads SET status='converted',contact_id=? WHERE id=?").run(cid, lid);
db.prepare("INSERT INTO opportunities(user_id,contact_id,title,value,stage) VALUES(?,?,?,?,'prospecting')").run(uid, cid, 'Acme deal', 5000);
ok(db.prepare('SELECT contact_id FROM leads WHERE id=?').get(lid).contact_id === cid, 'lead linked to new contact');
ok(db.prepare('SELECT status FROM leads WHERE id=?').get(lid).status === 'converted', 'lead status -> converted');
ok(db.prepare('SELECT value FROM opportunities WHERE contact_id=?').get(cid).value === 5000, 'opportunity created with value');

// 4. journey + steps + enrollment
const j = db.prepare('INSERT INTO journeys(user_id,name) VALUES(?,?)').run(uid, 'Welcome'); const jid = Number(j.lastInsertRowid);
db.prepare('INSERT INTO journey_steps(journey_id,day_offset,subject,body,step_order) VALUES(?,?,?,?,?)').run(jid, 0, 'Hi {{name}}', 'Welcome', 0);
db.prepare('INSERT INTO journey_steps(journey_id,day_offset,subject,body,step_order) VALUES(?,?,?,?,?)').run(jid, 3, 'Follow up', 'Hello {{company}}', 1);
db.prepare('INSERT INTO enrollments(user_id,journey_id,contact_id) VALUES(?,?,?)').run(uid, jid, cid);
ok(db.prepare('SELECT COUNT(*) n FROM journey_steps WHERE journey_id=?').get(jid).n === 2, 'journey created with 2 steps');

// 5. reminder
db.prepare('INSERT INTO reminders(user_id,contact_id,channel,title,due_at) VALUES(?,?,?,?,?)').run(uid, cid, 'push', 'Call Acme', '2026-01-01 09:00:00');
ok(db.prepare('SELECT sent FROM reminders WHERE user_id=?').get(uid).sent === 0, 'reminder queued (unsent)');

// 6. stats query (mirrors /stats)
const leads = db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id=?').get(uid).n;
const pipeline = db.prepare("SELECT COALESCE(SUM(value),0) n FROM opportunities WHERE user_id=? AND stage NOT IN ('won','lost')").get(uid).n;
ok(leads === 1 && pipeline === 5000, 'dashboard stats compute (pipeline=$5000)');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
