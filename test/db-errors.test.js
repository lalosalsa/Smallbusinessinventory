'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { explainConnectionError } = require('../src/db-errors');

const cases = [
  ['password authentication failed for user "postgres"', [/refused the password/, /percent-encoded/]],
  ['getaddrinfo ENOTFOUND db.example.supabase.co', [/could not be looked up/, /pooler\.supabase\.com/]],
  ['connect ENETUNREACH 2600:1f16::1:5432', [/IPv6-only/, /Transaction pooler/]],
  ['connect ECONNREFUSED 127.0.0.1:5432', [/Nothing is listening/, /6543/]],
  ['Connection terminated due to connection timeout', [/timed out/, /paused/]],
  ['self-signed certificate in certificate chain', [/certificate/, /PGSSL_NO_VERIFY/]],
  ['Tenant or user not found', [/pooler did not recognise/, /postgres\.<project-ref>/]],
];

for (const [message, expected] of cases) {
  test(`explains: ${message.slice(0, 40)}`, () => {
    const advice = explainConnectionError(new Error(message));
    for (const pattern of expected) assert.match(advice, pattern);
  });
}

test('an unfamiliar error is passed through rather than guessed at', () => {
  const advice = explainConnectionError(new Error('something nobody has seen before'));
  assert.match(advice, /something nobody has seen before/);
  assert.match(advice, /Check DATABASE_URL/);
});

test('it copes with a thrown value that is not an Error', () => {
  assert.match(explainConnectionError('plain string'), /plain string/);
  assert.match(explainConnectionError(null), /Check DATABASE_URL/);
});
