# Connecting the app to Supabase

Ten minutes, start to finish. You need a Supabase project — the free tier is plenty for a
few locations.

## 1. Get the connection string

Supabase dashboard → **Project Settings → Database → Connection string → Transaction
pooler**. It looks like this:

```
postgresql://postgres.abcdefghijklm:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

Swap `[YOUR-PASSWORD]` for your database password (the one you set when you created the
project; you can reset it on the same page).

## 2. Write your .env

```bash
cp .env.example .env
```

```ini
DATABASE_URL=postgresql://postgres.abcdefghijklm:your-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

That is the only line you need. Sign-in is handled by the app itself, so nobody has to
confirm an email address or type a verification code to get in — they pick a password and
they are in.

`.env` is git-ignored. Keep it out of version control and off shared drives.

## 3. Create the tables

```bash
npm install
npm start
```

The app applies `sql/schema.sql` on boot, so the tables appear by themselves, and it is
safe to re-run as the app is updated. If you would rather run it by hand, paste
`sql/schema.sql` into the Supabase **SQL Editor** and set `SKIP_MIGRATE=1` in `.env`.

## 4. Set up your business, then hand out join codes

Open the app, create your sign-in, choose **Start a new business** and name it along with
its locations.

Then **People → Create join code**. Pick the role and the locations the code should grant,
and how many people may use it. You get something like `BREW-4K7Q`. Whoever you give it to
signs up at the same web address, types the code, and is in — on your account, with the
role and locations you chose. Nothing is emailed and nobody waits on a link.

Codes can be capped to a number of uses, set to expire, tied to one email address, or
turned off at any time.

## Optional: sign in through Supabase Auth instead

Only worth it if you want Supabase's password-reset emails. Copy the **Project URL** and
the **anon public** key from **Project Settings → API** (never the `service_role` key —
this app has no use for it) and add:

```ini
AUTH_MODE=supabase
SUPABASE_URL=https://abcdefghijklm.supabase.co
SUPABASE_ANON_KEY=eyJ...
```

Before you do, turn **Confirm email** off under **Authentication → Sign In / Providers →
Email**. Supabase has it on by default, which would make every new person click an emailed
link before their first sign-in. If the setting is still on, the app says exactly that
rather than leaving anyone stuck. Supabase's built-in email service is also rate-limited;
for more than a handful of people you would need SMTP set up under **Authentication →
Emails**.

## Security notes

- The Express server talks to Postgres with your database credentials and enforces the
  account and location rules itself. Every query is scoped to the signed-in person's
  account, and the tests in `test/accounts.test.js` hold that behaviour in place.
- Because the browser never talks to Postgres directly, Row Level Security is not what
  keeps accounts apart here — the server is. If you later want to query Supabase straight
  from another client, add RLS policies before you do.
- Join codes are the keys to your data. They are short on purpose, so cap the uses, set an
  expiry for anything you post in a group chat, and turn a code off once the people who
  needed it are in.
- Keep the app off the open internet unless it is behind HTTPS. Sign-in tokens travel in
  an `Authorization` header, which is only as private as the connection carrying it.

## Backups

Supabase takes daily backups on paid plans. For your own copy:

```bash
pg_dump "$DATABASE_URL" > inventory-$(date +%F).sql
```
