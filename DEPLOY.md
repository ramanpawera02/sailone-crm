# Deploying SailOne CRM on Render with a permanent database

Your data now lives in **PostgreSQL** — a real database that keeps everything safe no
matter how many times the app restarts. You still deploy on Render exactly as before;
you just point the app at a database. Total time: about 15 minutes.

There are three pieces: **GitHub** (holds the code), **Neon** (the free permanent
database), and **Render** (runs the app). Do them in order.

---

## Step 1 — Code on GitHub

If your code is already on GitHub from before, just replace the files with this updated
version (drag the folder in again and commit). Otherwise:

1. github.com → **New repository** → name it `sailone-crm` → **Create**.
2. Click **uploading an existing file**, drag in everything from the `sailone-crm`
   folder, **Commit changes**. (The `.gitignore` keeps junk out automatically.)

---

## Step 2 — Create the free database on Neon

1. Go to **neon.tech** and sign up (free, no card needed).
2. It creates a project and a database for you automatically.
3. On the project dashboard, find **Connection string** (sometimes under "Connect").
   Copy it. It looks like:
   ```
   postgresql://username:password@ep-cool-name-123.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
4. Keep that string handy for the next step. That single line is everything the app
   needs to reach your database.

> Neon's free tier is meant to be permanent — it won't expire like Render's free
> database does. Supabase works identically if you prefer it.

---

## Step 3 — Point Render at the database

1. Open your CRM service on Render → **Environment**.
2. Add one variable:
   - **Key:** `DATABASE_URL`
   - **Value:** *(paste the Neon connection string from Step 2)*
3. While you're here, make sure these are also set (from earlier):
   - `JWT_SECRET` — your long random secret
   - `NODE_ENV` = `production`
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — for phone push
   - `ANTHROPIC_API_KEY` — for "Talk to add a lead" (get one at console.anthropic.com).
     Optional; without it a basic built-in parser is used instead.
4. Click **Save Changes**. Render redeploys automatically.

When `DATABASE_URL` is present, the app automatically uses Postgres and creates all its
tables on first start — you don't have to set anything up in the database yourself.

**You can now delete the persistent-disk setup if you added one** — Postgres replaces it.
Remove the `DB_PATH` variable too; it's only used by the local-file mode.

That's it. Create your account on the live site and your data will stick around for good.

---

## What about the reminders sleeping?

Separate from the database: on Render's **free** web-service plan the app sleeps when
idle, and the every-minute reminder checker only runs while it's awake — so a reminder
due during a nap won't fire on time. If on-time phone reminders matter, move the web
service to the **Starter** plan (it stays awake 24/7). The database change above does not
require any paid plan on its own.

---

## Running it on your own computer (optional)

You don't need Postgres just to test locally. With no `DATABASE_URL` set, the app falls
back to a local SQLite file:

```
npm install
npm start         # opens http://localhost:3000, data saved to a local file
```

To test against Postgres locally instead, put `DATABASE_URL=...` in a `.env` file.

---

## Other hosts

The included `Dockerfile`, `fly.toml`, and `Procfile` still work for Railway / Fly.io —
just set the same `DATABASE_URL` environment variable there instead of on Render.
