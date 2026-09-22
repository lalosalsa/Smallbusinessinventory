'use strict';

const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

/**
 * Postgres access layer. Works against a Supabase project or any Postgres.
 *
 * Queries use readable :named parameters; `sql()` rewrites them to $1, $2 ... so
 * nothing is ever interpolated into a statement.
 */

// numeric and bigint come back as strings by default, and DATE as a JS Date in
// the server's timezone (which can shift the day). Keep them as we mean them.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
types.setTypeParser(1082, (v) => v);

// bigint[] (store_ids) arrives as the literal '{1,2}' and keeps its elements as
// strings unless we say otherwise, which quietly breaks id comparisons in JS.
types.setTypeParser(1016, (v) => {
  if (v === null) return null;
  const inner = v.replace(/^\{|\}$/g, '');
  return inner ? inner.split(',').map(Number) : [];
});

const CONNECTION = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';

function sslSetting(connection) {
  if (process.env.PGSSL === 'disable') return false;
  if (!connection) return false;
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connection);
  if (local) return false;
  // Supabase terminates TLS with a public certificate chain.
  return { rejectUnauthorized: process.env.PGSSL_NO_VERIFY === '1' ? false : true };
}

const pool = new Pool({
  connectionString: CONNECTION,
  ssl: sslSetting(CONNECTION),
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => console.error('Postgres pool error:', err.message));

/** Rewrites ":name" placeholders to positional parameters, leaving ::casts alone. */
function sql(text, params = {}) {
  const values = [];
  const seen = new Map();
  const rewritten = text.replace(/::?([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
    if (match.startsWith('::')) return match; // a cast, not a parameter
    if (!(name in params)) throw new Error(`Missing bind parameter :${name}`);
    if (!seen.has(name)) {
      values.push(params[name]);
      seen.set(name, values.length);
    }
    return `$${seen.get(name)}`;
  });
  return { text: rewritten, values };
}

function bind(executor) {
  const api = {
    async all(text, params = {}) {
      const { text: q, values } = sql(text, params);
      return (await executor.query(q, values)).rows;
    },
    async one(text, params = {}) {
      const rows = await api.all(text, params);
      return rows[0] || null;
    },
    async value(text, params = {}) {
      const row = await api.one(text, params);
      return row ? Object.values(row)[0] : null;
    },
    async run(text, params = {}) {
      const { text: q, values } = sql(text, params);
      const res = await executor.query(q, values);
      return { rowCount: res.rowCount, rows: res.rows };
    },
  };
  return api;
}

const db = bind(pool);

/** Runs `fn` inside a transaction, handing it a handle bound to that connection. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(bind(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Applies sql/schema.sql. It is idempotent, so it is safe on every boot. */
async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  await pool.query(schema);
}

async function ping() {
  if (!CONNECTION) throw new Error('DATABASE_URL is not set — point it at your Supabase connection string');
  await pool.query('SELECT 1');
}

async function close() { await pool.end(); }

module.exports = { db, tx, bind, sql, pool, migrate, ping, close, CONNECTION };
