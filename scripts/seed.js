'use strict';

/**
 * Loads a demo account: an owner, two locations, four suppliers, a product list,
 * eight weeks of weekly counts and deliveries, and a few standing order days.
 *
 *   npm run seed                     add the demo account
 *   npm run seed -- --reset          clear every account first
 *   npm run seed -- --email me@x.com --password secret123
 */

require('../src/env').load();

const fs = require('fs');
const path = require('path');
const { db, migrate, close } = require('../src/db');
const { importProducts } = require('../src/importer');
const { saveSchedule } = require('../src/schedules');
const auth = require('../src/auth');
const accounts = require('../src/accounts');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};

const RESET = args.includes('--reset');
const EMAIL = flag('email', 'owner@example.com');
const PASSWORD = flag('password', 'password123');
const WEEKS = 8;

async function main() {
  await migrate();

  if (RESET) {
    await db.run('TRUNCATE accounts, local_users CASCADE');
    console.log('Cleared existing accounts.');
  }

  const user = await signInOrRegister();
  let member = await accounts.membershipFor(user);
  if (!member) {
    member = await accounts.createAccount(user, { name: 'Demo Cafe Co', locations: ['Downtown Cafe', 'Riverside Cafe'] });
    console.log(`Created the account "Demo Cafe Co" with ${EMAIL} as owner.`);
  }
  const accountId = member.account_id;

  const stores = await db.all('SELECT * FROM stores WHERE account_id = :a ORDER BY name', { a: accountId });
  const codes = { 'Downtown Cafe': 'S1', 'Riverside Cafe': 'S2' };
  for (const store of stores) {
    if (codes[store.name] && store.code !== codes[store.name]) {
      await db.run('UPDATE stores SET code = :code WHERE id = :id', { code: codes[store.name], id: store.id });
    }
  }

  const csv = fs.readFileSync(path.join(__dirname, '..', 'public', 'samples', 'products-sample.csv'), 'utf8');
  const imported = await importProducts(accountId, csv);
  console.log(`Imported ${imported.products_created + imported.products_updated} products and ${imported.links_created} supplier SKUs.`);

  await fillInSuppliers(accountId);
  const pairs = await writeHistory(accountId);
  console.log(`Wrote ${WEEKS + 1} weekly counts and deliveries for ${pairs} location/product pairs.`);
  const schedules = await addSchedules(accountId);
  console.log(`Set up ${schedules} standing order days.`);

  console.log('');
  console.log('Done. Start the app with: npm start');
  if (auth.authMode() === 'local') console.log(`Sign in as ${EMAIL} / ${PASSWORD}`);
  else console.log(`Sign in through Supabase as ${EMAIL}`);
}

async function signInOrRegister() {
  if (auth.authMode() !== 'local') {
    const existing = await db.one('SELECT * FROM members WHERE lower(email) = lower(:email)', { email: EMAIL });
    if (!existing) {
      throw new Error(`This project uses Supabase Auth. Sign up as ${EMAIL} in the app first, then run the seed again.`);
    }
    return { id: existing.user_id, email: existing.email, display_name: existing.display_name };
  }
  try {
    return (await auth.registerLocalUser({ email: EMAIL, password: PASSWORD, display_name: 'Owner' })).user;
  } catch {
    return (await auth.loginLocal({ email: EMAIL, password: PASSWORD })).user;
  }
}

async function fillInSuppliers(accountId) {
  const details = {
    Sysco: { email: 'orders@sysco-example.com', phone: '555-0110', account_number: 'A-88213', order_days: 'Mon, Thu', lead_time_days: 2, min_order_value: 250 },
    'Restaurant Depot': { email: 'will-call@rd-example.com', phone: '555-0144', account_number: 'RD-4471', order_days: 'Any', lead_time_days: 0, min_order_value: 0 },
    'Bay Coffee Roasters': { email: 'hello@baycoffee-example.com', phone: '555-0199', account_number: 'BCR-102', order_days: 'Tue', lead_time_days: 3, min_order_value: 150 },
    'Pacific Paper': { email: 'sales@pacificpaper-example.com', phone: '555-0177', account_number: 'PP-3390', order_days: 'Wed', lead_time_days: 5, min_order_value: 200 },
  };
  for (const [name, d] of Object.entries(details)) {
    await db.run(`
      UPDATE suppliers SET email = :email, phone = :phone, account_number = :account,
                           order_days = :days, lead_time_days = :lead, min_order_value = :min
      WHERE account_id = :a AND name = :name
    `, { ...d, account: d.account_number, days: d.order_days, lead: d.lead_time_days, min: d.min_order_value, a: accountId, name });
  }
}

/** Count on Monday, take a delivery midweek, count again next Monday — eight times over. */
async function writeHistory(accountId) {
  await db.run('TRUNCATE counts, receipts CASCADE');
  const tracked = await db.all('SELECT store_id, product_id, par_level FROM store_products WHERE account_id = :a AND par_level > 0', { a: accountId });

  const stamp = (daysAgo, hour) => {
    const d = new Date(Date.now() - daysAgo * 86400000);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  for (const row of tracked) {
    let onHand = Number(row.par_level);
    for (let week = WEEKS; week >= 0; week--) {
      const countDay = week * 7;
      await db.run(`INSERT INTO counts (account_id, store_id, product_id, qty, counted_at, note)
                    VALUES (:a, :s, :p, :q, :at, 'Weekly count')`,
        { a: accountId, s: row.store_id, p: row.product_id, q: round(onHand), at: stamp(countDay, 8) });

      if (week === 0) {
        await db.run('UPDATE store_products SET on_hand = :q WHERE store_id = :s AND product_id = :p',
          { q: round(onHand), s: row.store_id, p: row.product_id });
        break;
      }

      // Weekly usage wobbles around 60% of par, with a seasonal lift.
      const seasonal = 1 + 0.15 * Math.sin((WEEKS - week) / 2);
      const used = Number(row.par_level) * 0.6 * seasonal * (0.8 + Math.random() * 0.4);
      const delivered = Math.max(0, Math.round(Number(row.par_level) - onHand + used));
      if (delivered > 0) {
        await db.run(`INSERT INTO receipts (account_id, store_id, product_id, qty, received_at, note)
                      VALUES (:a, :s, :p, :q, :at, 'Weekly delivery')`,
          { a: accountId, s: row.store_id, p: row.product_id, q: delivered, at: stamp(countDay - 3, 10) });
      }
      onHand = Math.max(0, onHand + delivered - used);
    }
  }
  return tracked.length;
}

async function addSchedules(accountId) {
  await db.run('TRUNCATE order_schedules CASCADE');
  const specs = [
    { supplier: 'Sysco', store: 'S1', name: 'Weekly dairy order', frequency: 'weekly', day_of_week: 1 },
    { supplier: 'Sysco', store: 'S2', name: 'Weekly dairy order', frequency: 'weekly', day_of_week: 4 },
    { supplier: 'Bay Coffee Roasters', store: 'S1', name: 'Coffee', frequency: 'biweekly', day_of_week: 2 },
    { supplier: 'Pacific Paper', store: 'S1', name: 'Packaging top-up', frequency: 'monthly', day_of_month: 1 },
    { supplier: 'Restaurant Depot', store: 'S1', name: 'Dry goods run', frequency: 'days', interval_days: 10 },
  ];

  const anchor = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
  let made = 0;
  for (const spec of specs) {
    const supplier = await db.one('SELECT id FROM suppliers WHERE account_id = :a AND name = :name', { a: accountId, name: spec.supplier });
    const store = await db.one('SELECT id FROM stores WHERE account_id = :a AND code = :code', { a: accountId, code: spec.store });
    if (!supplier || !store) continue;
    await saveSchedule(accountId, {
      supplier_id: supplier.id,
      store_id: store.id,
      name: spec.name,
      frequency: spec.frequency,
      day_of_week: spec.day_of_week ?? null,
      day_of_month: spec.day_of_month ?? null,
      interval_days: spec.interval_days ?? null,
      anchor_date: anchor,
      mode: 'both',
    });
    made++;
  }
  return made;
}

function round(n) { return Math.round(n * 100) / 100; }

main()
  .then(() => close())
  .catch(async (err) => {
    console.error(err.message);
    await close();
    process.exit(1);
  });
