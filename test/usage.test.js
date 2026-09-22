'use strict';

const { db, resetDatabase, close } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { usageReport } = require('../src/usage');
const { suggestOrder } = require('../src/orders');

let accountId;
let storeId;
let otherStoreId;
let supplierId;
let productId;

before(async () => { await resetDatabase(); });
after(async () => { await close(); });

async function fixture() {
  await db.run('TRUNCATE accounts CASCADE');
  const account = await db.one("INSERT INTO accounts (name) VALUES ('Test') RETURNING *");
  accountId = account.id;

  const s1 = await db.one("INSERT INTO stores (account_id, name, code) VALUES (:a, 'Downtown', 'S1') RETURNING *", { a: accountId });
  const s2 = await db.one("INSERT INTO stores (account_id, name, code) VALUES (:a, 'Riverside', 'S2') RETURNING *", { a: accountId });
  storeId = s1.id;
  otherStoreId = s2.id;

  const supplier = await db.one("INSERT INTO suppliers (account_id, name, min_order_value) VALUES (:a, 'Acme', 100) RETURNING *", { a: accountId });
  supplierId = supplier.id;

  const product = await db.one("INSERT INTO products (account_id, name, base_unit) VALUES (:a, 'Milk', 'gal') RETURNING *", { a: accountId });
  productId = product.id;

  await db.run(`INSERT INTO product_suppliers (account_id, product_id, supplier_id, sku, pack_size, unit_cost, is_primary)
                VALUES (:a, :p, :s, 'SKU-1', 4, 20, true)`, { a: accountId, p: productId, s: supplierId });
}

const count = (store, qty, at) => db.run(
  'INSERT INTO counts (account_id, store_id, product_id, qty, counted_at) VALUES (:a, :s, :p, :q, :at)',
  { a: accountId, s: store, p: productId, q: qty, at },
);
const receipt = (store, qty, at) => db.run(
  'INSERT INTO receipts (account_id, store_id, product_id, qty, received_at, note) VALUES (:a, :s, :p, :q, :at, :n)',
  { a: accountId, s: store, p: productId, q: qty, at, n: 'test' },
);
const stock = (par, onHand) => db.run(
  'INSERT INTO store_products (account_id, store_id, product_id, par_level, on_hand) VALUES (:a, :s, :p, :par, :on)',
  { a: accountId, s: storeId, p: productId, par, on: onHand },
);
const report = (from, to, extra = {}) => usageReport({ accountId, from, to, ...extra });

test('usage is opening count plus deliveries minus closing count', async () => {
  await fixture();
  await count(storeId, 10, '2026-03-02T08:00:00Z');
  await receipt(storeId, 12, '2026-03-04T10:00:00Z');
  await count(storeId, 6, '2026-03-09T08:00:00Z');

  const rows = (await report('2026-03-01', '2026-03-31')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].used, 16); // 10 + 12 - 6
  assert.equal(rows[0].received, 12);
});

test('a delivery on the far side of the closing count is not counted twice', async () => {
  await fixture();
  await count(storeId, 10, '2026-03-02T08:00:00Z');
  await count(storeId, 4, '2026-03-09T08:00:00Z');
  await receipt(storeId, 20, '2026-03-09T15:00:00Z');
  await count(storeId, 18, '2026-03-16T08:00:00Z');

  assert.equal((await report('2026-03-01', '2026-03-31')).rows[0].used, 12);
});

test('only segments closing inside the window are reported', async () => {
  await fixture();
  await count(storeId, 10, '2026-01-05T08:00:00Z');
  await count(storeId, 4, '2026-01-12T08:00:00Z');
  await count(storeId, 1, '2026-03-09T08:00:00Z');

  assert.equal((await report('2026-03-01', '2026-03-31')).rows[0].used, 3);
});

test('weekly and monthly buckets split the same usage', async () => {
  await fixture();
  await count(storeId, 20, '2026-03-02T08:00:00Z');
  await count(storeId, 15, '2026-03-09T08:00:00Z');
  await count(storeId, 5, '2026-04-06T08:00:00Z');

  const weekly = await report('2026-03-01', '2026-04-30', { groupBy: 'week' });
  const monthly = await report('2026-03-01', '2026-04-30', { groupBy: 'month' });
  assert.equal(weekly.rows[0].used, 15);
  assert.deepEqual(Object.keys(monthly.rows[0].buckets).sort(), ['2026-03', '2026-04']);
  assert.deepEqual(monthly.rows[0].buckets, { '2026-03': 5, '2026-04': 10 });
});

test('a miscount that looks like negative usage does not cancel real usage out', async () => {
  await fixture();
  await count(storeId, 5, '2026-03-02T08:00:00Z');
  await count(storeId, 9, '2026-03-09T08:00:00Z');
  await count(storeId, 4, '2026-03-16T08:00:00Z');

  assert.equal((await report('2026-03-01', '2026-03-31')).rows[0].used, 5);
});

test('per-week and per-month averages scale from the window length', async () => {
  await fixture();
  await count(storeId, 14, '2026-03-01T08:00:00Z');
  await count(storeId, 0, '2026-03-14T08:00:00Z');

  const row = (await report('2026-03-01', '2026-03-14')).rows[0];
  assert.equal(row.per_day, 1);
  assert.equal(row.per_week, 7);
  assert.equal(row.per_month, 30);
});

test('usage can be narrowed to one location', async () => {
  await fixture();
  await count(storeId, 10, '2026-03-02T08:00:00Z');
  await count(storeId, 4, '2026-03-09T08:00:00Z');
  await count(otherStoreId, 8, '2026-03-02T08:00:00Z');
  await count(otherStoreId, 1, '2026-03-09T08:00:00Z');

  assert.equal((await report('2026-03-01', '2026-03-31')).rows.length, 2);
  const one = (await report('2026-03-01', '2026-03-31', { storeId })).rows;
  assert.equal(one.length, 1);
  assert.equal(one[0].used, 6);
});

test('one account never sees another account\'s movement', async () => {
  await fixture();
  await count(storeId, 10, '2026-03-02T08:00:00Z');
  await count(storeId, 4, '2026-03-09T08:00:00Z');

  const other = await db.one("INSERT INTO accounts (name) VALUES ('Someone else') RETURNING *");
  const rows = (await usageReport({ accountId: other.id, from: '2026-03-01', to: '2026-03-31' })).rows;
  assert.deepEqual(rows, []);
});

test('order suggestion tops up to par and rounds to whole packs', async () => {
  await fixture();
  await stock(12, 3);

  const sheet = await suggestOrder({ accountId, storeId, supplierId, mode: 'par' });
  assert.equal(sheet.lines.length, 1);
  assert.equal(sheet.lines[0].need_base, 9);
  assert.equal(sheet.lines[0].qty_packs, 3); // ceil(9 / 4)
  assert.equal(sheet.total, 60);
});

test('order suggestion warns when the draft is under the supplier minimum', async () => {
  await fixture();
  await stock(12, 3);
  const sheet = await suggestOrder({ accountId, storeId, supplierId, mode: 'par' });
  assert.equal(sheet.meets_minimum, false);
  assert.equal(sheet.shortfall, 40);
});

test('usage mode orders enough to cover the requested days', async () => {
  await fixture();
  await stock(0, 2);
  const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  await count(storeId, 20, at(14));
  await count(storeId, 13, at(7));
  await count(storeId, 6, at(0));

  const sheet = await suggestOrder({ accountId, storeId, supplierId, mode: 'usage', daysOfCover: 7, lookbackDays: 28 });
  assert.equal(sheet.lines[0].usage_per_day, 1);
  assert.equal(sheet.lines[0].need_base, 5);
  assert.equal(sheet.lines[0].qty_packs, 2);
});

test('nothing is suggested when stock is already at par', async () => {
  await fixture();
  await stock(12, 12);
  assert.equal((await suggestOrder({ accountId, storeId, supplierId, mode: 'par' })).lines.length, 0);
  assert.equal((await suggestOrder({ accountId, storeId, supplierId, mode: 'par', onlyNeeded: false })).lines.length, 1);
});
