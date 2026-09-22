'use strict';

// Tests run against a real Postgres, so the SQL they exercise is the SQL that ships.
// Point TEST_DATABASE_URL at any empty database (a local one, or a Supabase branch).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5433/inv_test';
process.env.PGSSL = process.env.PGSSL || 'disable';

// Sign-in runs in local mode for tests: no Supabase round-trips.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-do-not-use-in-production';

const { db, migrate, close } = require('../src/db');

const TABLES = [
  'order_items', 'orders', 'order_schedules', 'receipts', 'counts', 'store_products',
  'product_suppliers', 'products', 'suppliers', 'member_locations', 'invites', 'members',
  'stores', 'accounts', 'local_users',
];

async function resetDatabase() {
  await migrate();
  await db.run(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/** Boots the app on a random port and hands back a signed-in-aware client. */
async function startServer() {
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, { token = null, method = 'GET', body, raw = false } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return { status: res.status, headers: res.headers, payload: await res.text() };
    const type = res.headers.get('content-type') || '';
    return {
      status: res.status,
      headers: res.headers,
      payload: type.includes('json') ? await res.json() : await res.text(),
    };
  };

  return { base, server, call, stop: () => new Promise((r) => server.close(r)) };
}

/** Registers a user and returns a client bound to their token. */
async function signUp(call, { email, password = 'password123', display_name = '' } = {}) {
  const { payload, status } = await call('/api/auth/register', {
    method: 'POST', body: { email, password, display_name },
  });
  if (status !== 201) throw new Error(`register failed: ${JSON.stringify(payload)}`);

  const token = payload.token;
  const as = (path, options = {}) => call(path, { ...options, token });
  return { user: payload.user, token, as };
}

/** A signed-up owner with an account and two locations ready to go. */
async function signUpOwner(call, { email = 'owner@example.com', accountName = 'Test Cafe', locations = ['Downtown', 'Riverside'] } = {}) {
  const owner = await signUp(call, { email, display_name: 'Owner' });
  const { payload, status } = await owner.as('/api/accounts', { method: 'POST', body: { name: accountName, locations } });
  if (status !== 201) throw new Error(`account failed: ${JSON.stringify(payload)}`);
  const stores = (await owner.as('/api/stores')).payload;
  return { ...owner, member: payload, stores };
}

module.exports = { db, resetDatabase, startServer, signUp, signUpOwner, close };
