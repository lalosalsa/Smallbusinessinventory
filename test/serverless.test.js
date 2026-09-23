'use strict';

// The serverless entry (api/index.js) wraps the same Express app; these tests drive it
// the way Vercel does — a bare Node request handler with no listen() of its own.

const { resetDatabase, close, db } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.VERCEL = '1';

let server;
let base;

before(async () => {
  await resetDatabase();
  const handler = require('../api/index');
  server = http.createServer((req, res) => { handler(req, res); });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await close();
});

async function call(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, payload: type.includes('json') ? await res.json() : await res.text() };
}

test('the handler answers API requests with JSON, and boots the schema on first use', async () => {
  const { status, payload } = await call('/api/auth/config');
  assert.equal(status, 200);
  assert.equal(payload.mode, 'local');

  const tables = await db.all(`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'accounts'
  `);
  assert.equal(tables.length, 1, 'migrate ran on the first request');
});

test('an unknown API path is a JSON 404, never a host error page', async () => {
  const { status, payload } = await call('/api/definitely-not-a-thing');
  assert.equal(status, 404);
  assert.equal(payload.error, 'Unknown endpoint');
});

test('a full sign-up and join-code round trip works through the serverless path', async () => {
  const owner = await call('/api/auth/register', { method: 'POST', body: { email: 'sls-owner@example.com', password: 'password123' } });
  assert.equal(owner.status, 201);
  const token = owner.payload.token;

  const account = await call('/api/accounts', { method: 'POST', token, body: { name: 'Serverless Cafe', locations: ['Only'] } });
  assert.equal(account.status, 201);

  const code = await call('/api/members/invite', { method: 'POST', token, body: { role: 'staff', all_locations: true } });
  assert.equal(code.status, 201);
  assert.match(code.payload.code, /^SERV-/);

  const hire = await call('/api/auth/register', { method: 'POST', body: { email: 'sls-hire@example.com', password: 'password123' } });
  const joined = await call('/api/join', { method: 'POST', token: hire.payload.token, body: { code: code.payload.code } });
  assert.equal(joined.status, 201);
  assert.equal(joined.payload.account_name, 'Serverless Cafe');
});

test('several instances booting at once do not fight over the schema', async () => {
  const { migrate } = require('../src/db');
  await Promise.all(Array.from({ length: 6 }, () => migrate()));
  const count = await db.value("SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public'");
  assert.ok(count >= 15);
});

test('with no AUTH_SECRET on a serverless host, local sign-in refuses plainly', () => {
  const { assertSecretConfigured } = require('../src/auth');
  const saved = process.env.AUTH_SECRET;
  delete process.env.AUTH_SECRET;
  try {
    assert.throws(() => assertSecretConfigured(), /AUTH_SECRET is not set/);
  } finally {
    process.env.AUTH_SECRET = saved;
  }
  assert.doesNotThrow(() => assertSecretConfigured());
});
