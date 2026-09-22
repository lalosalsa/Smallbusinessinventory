'use strict';

/**
 * Tells you whether the app can reach your database, and what to do when it cannot.
 *
 *   npm run check-db
 */

require('../src/env').load();

const { db, pool, CONNECTION } = require('../src/db');
const { explainConnectionError } = require('../src/db-errors');

const TABLES = ['accounts', 'members', 'stores', 'products', 'suppliers', 'counts', 'orders', 'invites'];

async function main() {
  if (!CONNECTION) {
    console.error('DATABASE_URL is not set.');
    console.error('Copy .env.example to .env and put your Supabase connection string in it.');
    process.exit(1);
  }

  console.log(`Connecting to ${describe(CONNECTION)} ...`);

  const version = await db.value('SHOW server_version');
  console.log(`  connected. Postgres ${version}`);

  const found = await db.all(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(:tables)
  `, { tables: TABLES });

  const missing = TABLES.filter((t) => !found.some((f) => f.table_name === t));
  if (missing.length === TABLES.length) {
    console.log('  no tables yet — they are created the first time you run "npm start"');
  } else if (missing.length) {
    console.log(`  some tables are missing: ${missing.join(', ')}`);
    console.log('  run "npm start" to apply sql/schema.sql');
  } else {
    const accounts = await db.value('SELECT count(*)::int FROM accounts');
    const people = await db.value('SELECT count(*)::int FROM members');
    const locations = await db.value('SELECT count(*)::int FROM stores');
    console.log(`  schema is in place: ${accounts} account(s), ${locations} location(s), ${people} person/people`);
  }

  console.log('\nAll good. Start the app with: npm start');
}

/** The connection string with its password blanked out, so it is safe to paste. */
function describe(connection) {
  return String(connection).replace(/\/\/([^:]+):[^@]*@/, '//$1:••••••@');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('\nCould not connect.\n');
    console.error(explainConnectionError(err));
    await pool.end().catch(() => {});
    process.exit(1);
  });
