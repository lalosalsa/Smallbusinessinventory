'use strict';

require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const app = require('../server');
const { db } = require('../src/db');

let base;
let server;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

async function call(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, payload, headers: res.headers };
}

function reset() {
  db.exec(`DELETE FROM order_items; DELETE FROM orders; DELETE FROM receipts; DELETE FROM counts;
           DELETE FROM store_products; DELETE FROM product_suppliers; DELETE FROM products; DELETE FROM suppliers;`);
}

const PRODUCT_CSV = [
  'Item,Category,Unit,Vendor,Vendor SKU,Case Size,Order Unit,Case Price,Store,Par,Reorder,On Hand',
  'Whole Milk,Dairy,gal,Sysco,SY-1,4,case,14.80,S1,12,4,3',
  'Whole Milk,Dairy,gal,Sysco,SY-1,4,case,14.80,S2,8,3,8',
  '"Espresso, dark roast",Coffee,lb,Bay Roasters,BCR-1,5,bag,72.00,S1,25,10,10',
].join('\n');

test('imports a supplier spreadsheet with unfamiliar headers', async () => {
  reset();
  const { status, payload } = await call('/api/import/products', { method: 'POST', body: { csv: PRODUCT_CSV } });
  assert.equal(status, 200);
  assert.equal(payload.products_created, 2);
  assert.equal(payload.suppliers_created, 2);
  assert.equal(payload.links_created, 2);
  assert.equal(payload.store_rows, 3);
  assert.deepEqual(payload.errors, []);

  const products = (await call('/api/products')).payload;
  assert.equal(products.length, 2);
  assert.equal(products.find((p) => p.name === 'Espresso, dark roast').suppliers[0].sku, 'BCR-1');
});

test('re-importing the same file updates rather than duplicates', async () => {
  const before = (await call('/api/products')).payload.length;
  const { payload } = await call('/api/import/products', { method: 'POST', body: { csv: PRODUCT_CSV } });
  assert.equal(payload.products_created, 0);
  assert.equal(payload.products_updated, 3);
  assert.equal((await call('/api/products')).payload.length, before);
});

test('rejects a second product claiming a SKU another product already uses', async () => {
  const csv = 'product_name,supplier_name,sku\nSomething Else,Sysco,SY-1\n';
  const { payload } = await call('/api/import/products', { method: 'POST', body: { csv } });
  assert.equal(payload.errors.length, 1);
  assert.match(payload.errors[0], /already used/);
});

test('inventory shows per-store stock, par and what is short', async () => {
  const stores = (await call('/api/stores')).payload;
  const s1 = stores.find((s) => s.code === 'S1');
  const rows = (await call(`/api/inventory?store_id=${s1.id}`)).payload;
  const milk = rows.find((r) => r.product_name === 'Whole Milk');
  assert.equal(milk.on_hand, 3);
  assert.equal(milk.par_level, 12);
  assert.equal(milk.needed, 9);
  assert.equal(milk.sku, 'SY-1');

  const short = (await call(`/api/inventory?store_id=${s1.id}&only=below_par`)).payload;
  assert.ok(short.every((r) => r.on_hand < r.par_level));
});

test('saving a count writes history and resets on hand', async () => {
  const s1 = (await call('/api/stores')).payload.find((s) => s.code === 'S1');
  const milk = (await call('/api/products?search=Whole Milk')).payload[0];

  const saved = await call('/api/counts', {
    method: 'POST',
    body: { store_id: s1.id, counted_at: '2026-03-02', note: 'Monday', lines: [{ product_id: milk.id, qty: 5 }] },
  });
  assert.equal(saved.payload.saved, 1);

  const rows = (await call(`/api/inventory?store_id=${s1.id}`)).payload;
  assert.equal(rows.find((r) => r.product_id === milk.id).on_hand, 5);
  assert.equal((await call(`/api/counts?store_id=${s1.id}`)).payload[0].qty, 5);
});

test('a count sheet CSV imports against SKUs', async () => {
  const s1 = (await call('/api/stores')).payload.find((s) => s.code === 'S1');
  const csv = 'store_code,sku,qty,date\nS1,SY-1,2,2026-03-09\nS1,NOPE-9,4,2026-03-09\n';
  const { payload } = await call('/api/import/counts', { method: 'POST', body: { csv } });
  assert.equal(payload.counts, 1);
  assert.equal(payload.errors.length, 1);
  assert.match(payload.errors[0], /no product matches/i);

  const rows = (await call(`/api/inventory?store_id=${s1.id}`)).payload;
  assert.equal(rows.find((r) => r.sku === 'SY-1').on_hand, 2);
});

test('usage appears once a product has two counts', async () => {
  const from = '2026-03-01';
  const to = '2026-03-31';
  const report = (await call(`/api/usage?from=${from}&to=${to}`)).payload;
  const milk = report.rows.find((r) => r.product_name === 'Whole Milk');
  assert.equal(milk.used, 3); // counted 5, then 2, nothing delivered
});

test('the whole order loop: suggest, save, export, receive', async () => {
  const s1 = (await call('/api/stores')).payload.find((s) => s.code === 'S1');
  const sysco = (await call('/api/suppliers')).payload.find((s) => s.name === 'Sysco');

  const sheet = (await call('/api/orders/suggest', {
    method: 'POST', body: { store_id: s1.id, supplier_id: sysco.id, mode: 'par' },
  })).payload;
  assert.equal(sheet.lines.length, 1);
  assert.equal(sheet.lines[0].qty_packs, 3); // short 10 gal, 4 per case

  const order = (await call('/api/orders', {
    method: 'POST', body: { store_id: s1.id, supplier_id: sysco.id, note: 'Thursday', lines: sheet.lines },
  })).payload;
  assert.equal(order.status, 'draft');
  assert.equal(order.total, 44.4);

  const csv = (await call(`/api/orders/${order.id}/export.csv`)).payload;
  assert.match(csv, /Supplier SKU,Product/);
  assert.match(csv, /SY-1,Whole Milk,Dairy,3,case/);
  assert.match(csv, /ORDER TOTAL/);

  const sent = (await call(`/api/orders/${order.id}/status`, { method: 'POST', body: { status: 'sent' } })).payload;
  assert.equal(sent.status, 'sent');

  const received = (await call(`/api/orders/${order.id}/receive`, { method: 'POST', body: {} })).payload;
  assert.equal(received.status, 'received');

  // 3 cases x 4 gal added to the 2 gal counted earlier.
  const rows = (await call(`/api/inventory?store_id=${s1.id}`)).payload;
  assert.equal(rows.find((r) => r.sku === 'SY-1').on_hand, 14);
});

test('a delivery is stock in, and the difference either side of it is usage', async () => {
  const s1 = (await call('/api/stores')).payload.find((s) => s.code === 'S1');
  const milk = (await call('/api/products?search=Whole Milk')).payload[0];

  await call('/api/counts', { method: 'POST', body: { store_id: s1.id, counted_at: '2026-04-01', lines: [{ product_id: milk.id, qty: 2 }] } });
  const booked = await call('/api/receipts', {
    method: 'POST',
    body: { store_id: s1.id, product_id: milk.id, qty: 12, received_at: '2026-04-03', note: 'Walk-in buy' },
  });
  assert.equal(booked.status, 201);
  await call('/api/counts', { method: 'POST', body: { store_id: s1.id, counted_at: '2026-04-08', lines: [{ product_id: milk.id, qty: 5 }] } });

  const report = (await call('/api/usage?from=2026-04-01&to=2026-04-30')).payload;
  const row = report.rows.find((r) => r.product_name === 'Whole Milk');
  assert.equal(row.received, 12);
  assert.equal(row.used, 9); // 2 on hand + 12 delivered - 5 left
});

test('order sheets export the supplier CSV with a filename', async () => {
  const order = (await call('/api/orders')).payload[0];
  const res = await fetch(`${base}/api/orders/${order.id}/export.csv`);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="order-\d+-sysco-s1\.csv"/);
  assert.match(res.headers.get('content-type'), /text\/csv/);
});

test('the product export round-trips back through the importer', async () => {
  const csv = (await call('/api/export/products.csv')).payload;
  const { payload } = await call('/api/import/products', { method: 'POST', body: { csv } });
  assert.deepEqual(payload.errors, []);
  assert.equal(payload.products_created, 0);
});

test('bad requests answer with a message, not a stack trace', async () => {
  assert.equal((await call('/api/inventory')).status, 400);
  assert.equal((await call('/api/usage?from=2026-01-01')).status, 400);
  assert.equal((await call('/api/orders/99999')).status, 404);
  assert.equal((await call('/api/nope')).status, 404);
  const { status, payload } = await call('/api/orders', { method: 'POST', body: { store_id: 1, supplier_id: 1, lines: [] } });
  assert.equal(status, 400);
  assert.match(payload.error, /at least one line/);
});

test('the dashboard summarises both stores', async () => {
  const { payload } = await call('/api/dashboard');
  assert.equal(payload.stores.length, 2);
  assert.ok(payload.stores.every((s) => 'below_par' in s && 'stock_value' in s));
  assert.ok(payload.counts.products >= 2);
});

test('order schedules save, come back due, and raise a draft over HTTP', async () => {
  const s1 = (await call('/api/stores')).payload.find((s) => s.code === 'S1');
  const sysco = (await call('/api/suppliers')).payload.find((s) => s.name === 'Sysco');

  const created = await call('/api/schedules', {
    method: 'POST',
    body: {
      supplier_id: sysco.id, store_id: s1.id, name: 'Weekly dairy',
      frequency: 'weekly', day_of_week: new Date().getUTCDay(),
      anchor_date: '2026-01-01', mode: 'par', lead_time_days: 2,
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.status, 'due_today');
  assert.equal(created.payload.summary.startsWith('Every'), true);

  const listed = (await call('/api/schedules')).payload;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].supplier_name, 'Sysco');

  const upcoming = (await call('/api/schedules/upcoming?days=30')).payload;
  assert.ok(upcoming.length >= 4, 'the next month of order days is listed');
  assert.equal(upcoming[0].is_due, true);

  // Count the shelf up to par: the order day comes and goes without raising anything.
  const milk = (await call('/api/products?search=Whole Milk')).payload[0];
  await call('/api/counts', { method: 'POST', body: { store_id: s1.id, lines: [{ product_id: milk.id, qty: 12 }] } });
  const quiet = (await call(`/api/schedules/${created.payload.id}/run`, { method: 'POST', body: {} })).payload;
  assert.equal(quiet.order, null);
  assert.equal((await call(`/api/schedules/${created.payload.id}`)).payload.due_date, null);

  // Stock drops below par, and the next order day raises a draft.
  await call('/api/counts', { method: 'POST', body: { store_id: s1.id, lines: [{ product_id: milk.id, qty: 1 }] } });
  const forced = (await call(`/api/schedules/${created.payload.id}/run`, { method: 'POST', body: { force: true } })).payload;
  assert.ok(forced.order);
  assert.equal(forced.order.status, 'draft');
  assert.equal(forced.order.items[0].sku, 'SY-1');
});

test('an invalid schedule is refused with a readable message', async () => {
  const s1 = (await call('/api/stores')).payload.find((s) => s.code === 'S1');
  const { status, payload } = await call('/api/schedules', {
    method: 'POST', body: { store_id: s1.id, frequency: 'weekly', day_of_week: 1 },
  });
  assert.equal(status, 400);
  assert.match(payload.error, /supplier and a store/);
});

test('the dashboard reports schedules that are due', async () => {
  const { payload } = await call('/api/dashboard');
  assert.ok(Array.isArray(payload.schedule_due));
  assert.ok(Array.isArray(payload.schedule_upcoming));
  assert.ok(payload.schedule_upcoming.length > 0);
});

test('a supplier order sheet exports as CSV without saving an order first', async () => {
  const s1 = (await call('/api/stores')).payload.find((s) => s.code === 'S1');
  const sysco = (await call('/api/suppliers')).payload.find((s) => s.name === 'Sysco');
  const before = (await call('/api/orders')).payload.length;

  const res = await fetch(`${base}/api/orders/sheet.csv?store_id=${s1.id}&supplier_id=${sysco.id}&mode=par`);
  const csv = await res.text();
  assert.match(res.headers.get('content-disposition'), /order-sheet-sysco-s1\.csv/);
  assert.match(csv, /# Order sheet - Sysco/);
  assert.match(csv, /SY-1,Whole Milk/);
  assert.equal((await call('/api/orders')).payload.length, before, 'exporting does not raise an order');
});
