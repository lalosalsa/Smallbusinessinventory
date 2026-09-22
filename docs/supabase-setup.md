# Connecting the app to Supabase

Ten minutes, start to finish. You need a Supabase project — the free tier is plenty for
two or three locations.

## 1. Get the connection string

Supabase dashboard → **Project Settings → Database → Connection string → Transaction
pooler**. It looks like this:

```
postgresql://postgres.abcdefghijklm:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

Swap `[YOUR-PASSWORD]` for your database password (the one you set when you created the
project; you can reset it on the same page).

## 2. Get the API keys

Supabase dashboard → **Project Settings → API**. Copy:

- **Project URL** — `https://abcdefghijklm.supabase.co`
- **anon public** key — a long string starting `eyJ...`

The anon key is meant to be public; it ends up in the browser. Do not copy the
`service_role` key anywhere — this app never needs it.

## 3. Write your .env

```bash
cp .env.example .env
```

```ini
DATABASE_URL=postgresql://postgres.abcdefghijklm:your-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://abcdefghijklm.supabase.co
SUPABASE_ANON_KEY=eyJ...
```

`.env` is git-ignored. Keep it out of version control and off shared drives.

## 4. Create the tables

```bash
npm install
npm start
```

The app applies `sql/schema.sql` on boot, so the tables appear by themselves. If you would
rather run it by hand, paste `sql/schema.sql` into the Supabase **SQL Editor** and set
`SKIP_MIGRATE=1` in `.env`.

## 5. Sign up and invite your team

Open the app, create your sign-in, name the business and its locations. Then **People →
Invite someone**: they sign up through Supabase with the address you invited, and land on
your account with the role and locations you chose.

### Email settings worth checking

Supabase confirms new email addresses by default (**Authentication → Providers → Email**).
That is a sensible setting to leave on, but it means a new person must click a link in
their email before they can sign in for the first time. Supabase's built-in email service
is rate-limited; for more than a handful of people, set up SMTP under **Authentication →
Emails → SMTP Settings**.

## Security notes

- The Express server talks to Postgres with your database credentials and enforces the
  account and location rules itself. Every query is scoped to the signed-in person's
  account, and the tests in `test/accounts.test.js` hold that behaviour in place.
- Because the browser never talks to Postgres directly, Row Level Security is not what
  keeps accounts apart here — the server is. If you later want to query Supabase straight
  from another client, add RLS policies before you do.
- Keep the app off the open internet unless it is behind HTTPS. Sign-in tokens travel in
  an `Authorization` header, which is only as private as the connection carrying it.

## Backups

Supabase takes daily backups on paid plans. For your own copy:

```bash
pg_dump "$DATABASE_URL" > inventory-$(date +%F).sql
```
