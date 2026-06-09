# SailOne.ai CRM

A simple, voice-enabled CRM for a solo business owner. Capture a **Lead**, convert it
to a **Contact**, then attach **Opportunities** — and let the system handle email
journeys, customer drip campaigns, and phone reminders to call or email people.

Built to be easy to run: a single Node.js server, a file-based database (no separate
database to install), and one self-contained web page for the interface.

---

## Features

- **Login & security** — register/login with bcrypt-hashed passwords and JWT sessions
  (stored in a secure httpOnly cookie). Every record is scoped to the logged-in user.
- **Standard CRM flow** — Leads → Contacts → Opportunities, with a one-click
  "Convert" that turns a lead into a contact (and optionally opens an opportunity).
- **Talk to add anything** — a **🎤 Talk** button on the Leads, Contacts, Opportunities
  and Reminders tabs. Describe it in plain speech and Claude sorts it into the right
  fields, then opens the form pre-filled for you to review and save:
    - *Lead/Contact:* "Jane Smith from Acme, email jane@acme.com, met at the trade show."
    - *Opportunity:* "Deal with Acme, about 12 thousand dollars, in negotiation, closing end of next month." (the spoken contact is matched to your existing contacts)
    - *Reminder:* "Remind me to call Jane next Tuesday at 10am about pricing." (the date/time is worked out for you)

  Needs `ANTHROPIC_API_KEY`; without it a built-in parser still pulls out email, phone,
  name, company and deal amounts.
- **Backend database** — all leads, contacts, opportunities, reminders and journeys are
  stored in a real database. In the cloud it uses **PostgreSQL** (set `DATABASE_URL`);
  on your own computer it falls back to a local SQLite file automatically. `db.js` is the
  only file that touches the database. See `DEPLOY.md` for the Neon + Render setup.
- **Email reminders & customer journeys** — build multi-step drip sequences ("Day 0:
  welcome, Day 3: follow-up …") and enroll contacts. The scheduler sends each step
  automatically. Personalize with `{{name}}` and `{{company}}`.
- **Phone reminders** — schedule a reminder and get a push notification on your phone or
  desktop telling you to call or email a contact (via Web Push).
- **Dashboard** — counts of leads/contacts/opportunities and open pipeline value.

---

## Quick start (run locally)

You need [Node.js](https://nodejs.org) 18+ installed (Node 22+ recommended).

```bash
cd sailone-crm
npm install
cp .env.example .env        # then open .env and set JWT_SECRET (and email/push later)
npm start
```

Open **http://localhost:3000**, create your account, and you're in.

> The app works immediately without email or push configured — those features simply
> log to the console until you add credentials (below). Voice entry and the full
> CRM/database work out of the box.

---

## Turning on email (reminders + journeys)

Edit `.env` and fill in any SMTP provider. For Gmail, create an **App Password**
(Google Account → Security → 2-Step Verification → App passwords):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@sailone.ai
SMTP_PASS=your_16_char_app_password
MAIL_FROM="SailOne CRM <you@sailone.ai>"
```

Restart the server. Reminders set to the "email the customer" channel and all journey
steps will now actually send.

## Turning on phone reminders (Web Push)

1. Generate a key pair once:
   ```bash
   npx web-push generate-vapid-keys
   ```
2. Paste the two keys into `.env` (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`) and set
   `VAPID_SUBJECT=mailto:you@sailone.ai`.
3. Restart, click **🔔 Phone alerts** in the app header, and allow notifications.
   Add the site to your phone's home screen (Chrome/Android, or iOS 16.4+) to receive
   reminders there.

---

## Deploying to the cloud

See **`DEPLOY.md`** for the full click-by-click guide (GitHub → Neon Postgres → Render).
In short:

1. Push this folder to a Git repo.
2. Create a free PostgreSQL database (e.g. at neon.tech) and copy its connection string.
3. On the host, set start command `npm start` and add environment variables:
   `DATABASE_URL` (the connection string), `JWT_SECRET`, `NODE_ENV=production`, and the
   `VAPID_*` keys for phone push.
4. The app creates its tables automatically on first start. Your data is now permanent.

---

## How it's organized

| File | Purpose |
|------|---------|
| `server.js` | Web server + all API routes (auth, CRUD, convert, reminders, journeys, push) |
| `db.js` | Database connection + schema (the only DB-specific file) |
| `auth.js` | JWT signing + the "must be logged in" guard |
| `notify.js` | Sending email (nodemailer) and push (web-push) |
| `parse.js` | Turns spoken text into lead fields (Claude API, with a free fallback) |
| `scheduler.js` | Runs every minute: fires due reminders, advances journeys |
| `public/index.html` | The entire user interface (incl. voice entry) |
| `public/sw.js` | Service worker that displays push notifications |

---

## Notes & next steps

- **Tested:** the core data layer (password hashing, the Lead→Contact→Opportunity
  conversion, journeys, reminders, and dashboard stats) was verified end-to-end against
  the real schema — all checks pass.
- Voice recognition uses the Web Speech API, which works in Chrome and Edge; in browsers
  that don't support it the mic buttons simply hide themselves.
- Good things to add later: editing journey enrollments, an activity timeline per
  contact, CSV import/export, and SMS reminders (e.g. via Twilio) alongside push.
