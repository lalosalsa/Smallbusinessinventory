'use strict';

require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const { usageReport } = require('../src/usage');
const { suggestOrder } = require('../src/orders');

function reset() {
  db.exec(`DELETE FROM order_items; DELETE FROM orders; DELETE FROM receipts; DELETE FROM counts;
           DELETE FROM store_products; DELETE FROM product_suppliers; DELETE FROM products; DELETE FROM suppliers;`);
}

function fixture() {
  reset();
  const storeId = db.prepare('SELECT id FROM stores ORDER BY id').get().id;
  const supplierId = db.prepare("INSERT INTO suppliers (name, min_order_value) VALUES ('Acme', 100)").run().lastInsertRowid;
  const productId = db.prepare("INSERT INTO products (name, base_unit) VALUES ('Milk', 'gal')").run().lastInsertRowid;
  db.prepare(`INSERT INTO product_suppliers (product_id, supplier_id, sku, pack_size, pack_unit, unit_cost, is_primary)
              VALUES (?, ?, 'SKU-1', 4, 'case', 20, 1)`).run(productId, supplierId);
  return { storeId, supplierId, productId };
}

const count = (storeId, productId, qty, at) =>
  db.prepare('INSERT INTO counts (store_id, product_id, qty, counted_at) VALUES (?, ?, ?, ?)').run(storeId, productId, qty, at);
const receipt = (storeId, productId, qty, at) =>
  db.prepare('INSERT INTO receipts (store_id, product_id, qty, received_at) VALUES (?, ?, ?, ?)').run(storeId, productId, qty, at);

test('usage is opening count plus deliveries minus closing count', () => {
  const { storeId, productId } = fixture();
  count(storeId, productId, 10, '2026-03-02 08:00:00');
  receipt(storeId, productId, 12, '2026-03-04 10:00:00');
  count(storeId, productId, 6, '2026-03-09 08:00:00');

  const report = usageReport({ from: '2026-03-01', to: '2026-03-31' });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].used, 16); // 10 + 12 - 6
  assert.equal(report.rows[0].received, 12);
});

test('a delivery on the far side of the closing count is not counted twice', () => {
  const { storeId, productId } = fixture();
  count(storeId, productId, 10, '2026-03-02 08:00:00');
  count(storeId, productId, 4, '2026-03-09 08:00:00');
  receipt(storeId, productId, 20, '2026-03-09 15:00:00'); // after the closing count
  count(storeId, productId, 18, '2026-03-16 08:00:00');

  const rows = usageReport({ from: '2026-03-01', to: '2026-03-31' }).rows;
  assert.equal(rows[0].used, 12); // (10-4) for week one, (4+20-18)=6 for week two
});

test('only segments closing inside the window are reported', () => {
  const { storeId, productId } = fixture();
  count(storeId, productId, 10, '2026-01-05 08:00:00');
  count(storeId, productId, 4, '2026-01-12 08:00:00');  // outside
  count(storeId, productId, 1, '2026-03-09 08:00:00');  // inside

  const rows = usageReport({ from: '2026-03-01', to: '2026-03-31' }).rows;
  assert.equal(rows[0].used, 3); // only the segment closing on 2026-03-09
});

test('weekly and monthly buckets split the same usage', () => {
  const { storeId, productId } = fixture();
  count(storeId, productId, 20, '2026-03-02 08:00:00');
  count(storeId, productId, 15, '2026-03-09 08:00:00');
  count(storeId, productId, 5, '2026-04-06 08:00:00');

  const weekly = usageReport({ from: '2026-03-01', to: '2026-04-30', groupBy: 'week' });
  const monthly = usageReport({ from: '2026-03-01', to: '2026-04-30', groupBy: 'month' });
  assert.equal(weekly.rows[0].used, 15);
  assert.deepEqual(Object.values(monthly.rows[0].buckets), [5, 10]);
  assert.deepEqual(Object.keys(monthly.rows[0].buckets).sort(), ['2026-03', '2026-04']);
});

test('a miscount that looks like negative usage does not cancel real usage out', () => {
  const { storeId, productId } = fixture();
  count(storeId, productId, 5, '2026-03-02 08:00:00');
  count(storeId, productId, 9, '2026-03-09 08:00:00');  // more than could have arrived
  count(storeId, productId, 4, '2026-03-16 08:00:00');

  const rows = usageReport({ from: '2026-03-01', to: '2026-03-31' }).rows;
  assert.equal(rows[0].used, 5); // the bad segment contributes 0, not -4
});

test('per-week and per-month averages scale from the window length', () => {
  const { storeId, productId } = fixture();
  count(storeId, productId, 14, '2026-03-01 08:00:00');
  count(storeId, productId, 0, '2026-03-14 08:00:00');

  const row = usageReport({ from: '2026-03-01', to: '2026-03-14' }).rows[0];
  assert.equal(row.per_day, 1);
  assert.equal(row.per_week, 7);
  assert.equal(row.per_month, 30);
});

test('usage can be filtered to one store', () => {
  const { storeId, productId } = fixture();
  const other = db.prepare('SELECT id FROM stores WHERE id <> ?').get(storeId).id;
  count(storeId, productId, 10, '2026-03-02 08:00:00');
  count(storeId, productId, 4, '2026-03-09 08:00:00');
  count(other, productId, 8, '2026-03-02 08:00:00');
  count(other, productId, 1, '2026-03-09 08:00:00');

  assert.equal(usageReport({ from: '2026-03-01', to: '2026-03-31' }).rows.length, 2);
  const one = usageReport({ from: '2026-03-01', to: '2026-03-31', storeId }).rows;
  assert.equal(one.length, 1);
  assert.equal(one[0].used, 6);
});

test('order suggestion tops up to par and rounds to whole packs', () => {
  const { storeId, supplierId, productId } = fixture();
  db.prepare('INSERT INTO store_products (store_id, product_id, par_level, on_hand) VALUES (?, ?, 12, 3)').run(storeId, productId);

  const sheet = suggestOrder({ storeId, supplierId, mode: 'par' });
  assert.equal(sheet.lines.length, 1);
  assert.equal(sheet.lines[0].need_base, 9);   // 12 - 3
  assert.equal(sheet.lines[0].qty_packs, 3);   // ceil(9 / 4)
  assert.equal(sheet.total, 60);
});

test('order suggestion warns when the draft is under the supplier minimum', () => {
  const { storeId, supplierId, productId } = fixture();
  db.prepare('INSERT INTO store_products (store_id, product_id, par_level, on_hand) VALUES (?, ?, 12, 3)').run(storeId, productId);
  const sheet = suggestOrder({ storeId, supplierId, mode: 'par' });
  assert.equal(sheet.meets_minimum, false);
  assert.equal(sheet.shortfall, 40); // 100 minimum - 60 ordered
});

test('usage mode orders enough to cover the requested days', () => {
  const { storeId, supplierId, productId } = fixture();
  db.prepare('INSERT INTO store_products (store_id, product_id, par_level, on_hand) VALUES (?, ?, 0, 2)').run(storeId, productId);
  const today = new Date();
  const at = (daysAgo) => new Date(today.getTime() - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  count(storeId, productId, 20, at(14));
  count(storeId, productId, 13, at(7));  // 7 used in 7 days
  count(storeId, productId, 6, at(0));   // 7 used in 7 days -> 1 per day

  const sheet = suggestOrder({ storeId, supplierId, mode: 'usage', daysOfCover: 7, lookbackDays: 28 });
  assert.equal(sheet.lines[0].usage_per_day, 1);
  assert.equal(sheet.lines[0].need_base, 5); // 7 days of cover - 2 on hand
  assert.equal(sheet.lines[0].qty_packs, 2); // ceil(5 / 4)
});

test('nothing is suggested when stock is already at par', () => {
  const { storeId, supplierId, productId } = fixture();
  db.prepare('INSERT INTO store_products (store_id, product_id, par_level, on_hand) VALUES (?, ?, 12, 12)').run(storeId, productId);
  assert.equal(suggestOrder({ storeId, supplierId, mode: 'par' }).lines.length, 0);
  assert.equal(suggestOrder({ storeId, supplierId, mode: 'par', onlyNeeded: false }).lines.length, 1);
});
