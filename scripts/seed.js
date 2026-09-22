'use strict';

/**
 * Loads a demo dataset: two stores, four suppliers, a product list and eight weeks of
 * weekly counts and deliveries so the usage report and order suggestions have something
 * real to work with.
 *
 *   npm run seed            add demo data
 *   npm run seed -- --reset wipe everything first
 */

const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const { importProducts } = require('../src/importer');
const { saveSchedule } = require('../src/schedules');

const reset = process.argv.includes('--reset');

if (reset) {
  db.exec(`
    DELETE FROM order_items; DELETE FROM orders; DELETE FROM receipts; DELETE FROM counts;
    DELETE FROM store_products; DELETE FROM product_suppliers; DELETE FROM products; DELETE FROM suppliers;
  `);
  console.log('Cleared existing data.');
}

const stores = db.prepare('SELECT * FROM stores ORDER BY id').all();
db.prepare("UPDATE stores SET name = ?, code = ?, address = ? WHERE id = ?")
  .run('Downtown Cafe', 'S1', '118 Main St', stores[0].id);
if (stores[1]) {
  db.prepare("UPDATE stores SET name = ?, code = ?, address = ? WHERE id = ?")
    .run('Riverside Cafe', 'S2', '2400 River Rd', stores[1].id);
}

const csv = fs.readFileSync(path.join(__dirname, '..', 'public', 'samples', 'products-sample.csv'), 'utf8');
const result = importProducts(csv);
console.log(`Imported ${result.products_created + result.products_updated} products, ${result.links_created} supplier SKUs.`);

const supplierDetails = {
  Sysco: { email: 'orders@sysco-example.com', phone: '555-0110', account_number: 'A-88213', order_days: 'Mon, Thu', lead_time_days: 2, min_order_value: 250 },
  'Restaurant Depot': { email: 'will-call@rd-example.com', phone: '555-0144', account_number: 'RD-4471', order_days: 'Any', lead_time_days: 0, min_order_value: 0 },
  'Bay Coffee Roasters': { email: 'hello@baycoffee-example.com', phone: '555-0199', account_number: 'BCR-102', order_days: 'Tue', lead_time_days: 3, min_order_value: 150 },
  'Pacific Paper': { email: 'sales@pacificpaper-example.com', phone: '555-0177', account_number: 'PP-3390', order_days: 'Wed', lead_time_days: 5, min_order_value: 200 },
};
for (const [name, d] of Object.entries(supplierDetails)) {
  db.prepare(`UPDATE suppliers SET email = ?, phone = ?, account_number = ?, order_days = ?, lead_time_days = ?, min_order_value = ? WHERE name = ?`)
    .run(d.email, d.phone, d.account_number, d.order_days, d.lead_time_days, d.min_order_value, name);
}

// Eight weeks of history: count on Monday, take a delivery midweek, count again next Monday.
const WEEKS = 8;
const insertCount = db.prepare('INSERT INTO counts (store_id, product_id, qty, counted_at, note) VALUES (?, ?, ?, ?, ?)');
const insertReceipt = db.prepare('INSERT INTO receipts (store_id, product_id, qty, received_at, note) VALUES (?, ?, ?, ?, ?)');
const setStock = db.prepare(`
  INSERT INTO store_products (store_id, product_id, on_hand, updated_at) VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT (store_id, product_id) DO UPDATE SET on_hand = excluded.on_hand, updated_at = datetime('now')
`);

const tracked = db.prepare(`
  SELECT sp.store_id, sp.product_id, sp.par_level FROM store_products sp WHERE sp.par_level > 0
`).all();

const stamp = (daysAgo, hour) => {
  const d = new Date(Date.now() - daysAgo * 86400000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

db.transaction(() => {
  for (const row of tracked) {
    let onHand = row.par_level;
    for (let week = WEEKS; week >= 0; week--) {
      const countDay = week * 7;
      insertCount.run(row.store_id, row.product_id, round(onHand), stamp(countDay, 8), 'Weekly count');
      if (week === 0) { setStock.run(row.store_id, row.product_id, round(onHand)); break; }

      // Weekly usage wobbles around 60% of par, with a seasonal lift.
      const seasonal = 1 + 0.15 * Math.sin((WEEKS - week) / 2);
      const used = row.par_level * 0.6 * seasonal * (0.8 + Math.random() * 0.4);
      const delivered = Math.max(0, Math.round(row.par_level - onHand + used));
      if (delivered > 0) insertReceipt.run(row.store_id, row.product_id, delivered, stamp(countDay - 3, 10), 'Weekly delivery');
      onHand = Math.max(0, onHand + delivered - used);
    }
  }
})();

console.log(`Wrote ${WEEKS + 1} weekly counts and deliveries for ${tracked.length} store/product pairs.`);
// Standing order days, one per supplier, so the schedule screen has something in it.
const scheduleSpecs = [
  { supplier: 'Sysco', store: 'S1', name: 'Weekly dairy order', frequency: 'weekly', day_of_week: 1 },
  { supplier: 'Sysco', store: 'S2', name: 'Weekly dairy order', frequency: 'weekly', day_of_week: 4 },
  { supplier: 'Bay Coffee Roasters', store: 'S1', name: 'Coffee', frequency: 'biweekly', day_of_week: 2 },
  { supplier: 'Pacific Paper', store: 'S1', name: 'Packaging top-up', frequency: 'monthly', day_of_month: 1 },
  { supplier: 'Restaurant Depot', store: 'S1', name: 'Dry goods run', frequency: 'days', interval_days: 10 },
];

db.prepare('DELETE FROM order_schedules').run();
for (const spec of scheduleSpecs) {
  const supplier = db.prepare('SELECT id, lead_time_days FROM suppliers WHERE name = ?').get(spec.supplier);
  const store = db.prepare('SELECT id FROM stores WHERE code = ?').get(spec.store);
  if (!supplier || !store) continue;
  saveSchedule({
    supplier_id: supplier.id,
    store_id: store.id,
    name: spec.name,
    frequency: spec.frequency,
    day_of_week: spec.day_of_week ?? null,
    day_of_month: spec.day_of_month ?? null,
    interval_days: spec.interval_days ?? null,
    anchor_date: stamp(28, 12).slice(0, 10),
    mode: 'both',
  });
}
console.log(`Set up ${scheduleSpecs.length} standing order days.`);

console.log('Done. Start the app with: npm start');

function round(n) { return Math.round(n * 100) / 100; }
