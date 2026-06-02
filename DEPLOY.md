# Deploying SailOne CRM

The folder now includes config files so deploying is mostly clicking buttons:

- `render.yaml` — one-click blueprint for **Render** (incl. a persistent disk).
- `Procfile` — for **Railway** / Heroku-style hosts.
- `Dockerfile` + `fly.toml` — for **Fly.io** or any container host.
- `.gitignore` — keeps junk (node_modules, the local .db, logs) out of your repo.

---

## Step 0 — Get the code onto GitHub (needed for all hosts)

1. Make a free account at github.com → **New repository** → name it `sailone-crm` → **Create**.
2. On the new repo page, click **uploading an existing file** and drag in everything
   from your `sailone-crm` folder. The `.gitignore` means it's safe to drag the whole
   folder — Git skips `node_modules`, `.db`, and `.log` files automatically.
3. Click **Commit changes**.

You'll also want a strong session secret ready. Generate one by running this in a terminal
(Node installed), or just type a long random string of 40+ characters:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Option A — Render (recommended, easiest)

1. Go to render.com and sign up with GitHub.
2. **New + → Blueprint**. Pick your `sailone-crm` repo. Render reads `render.yaml` and
   pre-fills everything, including a 1 GB persistent disk and an auto-generated
   `JWT_SECRET`.
3. Click **Apply**. In ~2 minutes you get a URL like `https://sailone-crm.onrender.com`.
4. Open it, create your account, done.

Add email/push later: service → **Environment** → fill in the blank `SMTP_*` and
`VAPID_*` keys → Save (it redeploys automatically).

> The blueprint uses the **starter** plan because a persistent disk (so your data
> survives redeploys) requires it. If you'd rather start completely free, change
> `plan: starter` to `plan: free` and delete the `disk:` block in `render.yaml` — just
> know the database resets on each redeploy until you add the disk back.

---

## Option B — Railway

1. Go to railway.app → sign in with GitHub → **New Project → Deploy from GitHub repo**.
2. Pick `sailone-crm`. Railway detects Node and uses the `Procfile` (`npm start`).
3. **Variables** tab → add `JWT_SECRET`, `NODE_ENV=production`, and `DB_PATH=/data/sailone_crm.db`.
4. **Settings → Volumes** → add a volume mounted at `/data` (keeps your database).
5. Railway gives you a public URL under **Settings → Networking → Generate Domain**.

---

## Option C — Fly.io (most control, command-line)

Install the Fly CLI (`flyctl`), then in the project folder:

```
fly auth signup          # or: fly auth login
fly launch --no-deploy   # accepts the included fly.toml; pick a unique app name
fly volumes create crm_data --size 1
fly secrets set JWT_SECRET=your_long_random_secret
fly deploy
```

Add email/push anytime with more `fly secrets set KEY=value` commands, then `fly deploy`.

---

## After deploying — turning on the optional features

**Email (reminders + journeys):** set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
`MAIL_FROM`. For Gmail, make an App Password (Google Account → Security → 2-Step
Verification → App passwords).

**Phone push:** generate keys once with `npx web-push generate-vapid-keys`, set
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT=mailto:you@sailone.ai`. Then in
the app click **🔔 Phone alerts** and allow notifications (add the site to your phone's
home screen to get them there).

---

## A note on growing up to Postgres

SQLite on a persistent disk is perfectly fine for a solo business. If you later want
multiple machines or automatic backups, switch to managed Postgres — `db.js` is the only
file that talks to the database, so that's the single place to change. Ask me when you're
ready and I'll convert it.
