'use strict';

const { resetDatabase, startServer, signUpOwner, close } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let app;
let owner;
let stores;
let s1;
let s2;

before(async () => {
  await resetDatabase();
  app = await startServer();
  owner = await signUpOwner(app.call);
  stores = owner.stores;
  s1 = stores.find((s) => s.name === 'Downtown');
  s2 = stores.find((s) => s.name === 'Riverside');
});

after(async () => { await app.stop(); await close(); });

const PRODUCT_CSV = [
  'Item,Category,Unit,Vendor,Vendor SKU,Case Size,Order Unit,Case Price,Store,Par,Reorder,On Hand',
  'Whole Milk,Dairy,gal,Sysco,SY-1,4,case,14.80,S1,12,4,3',
  'Whole Milk,Dairy,gal,Sysco,SY-1,4,case,14.80,S2,8,3,8',
  '"Espresso, dark roast",Coffee,lb,Bay Roasters,BCR-1,5,bag,72.00,S1,25,10,10',
].join('\n').replace(/,S1,/g, ',DOWN,').replace(/,S2,/g, ',RIVE,');

test('an account starts with the locations the owner named', async () => {
  assert.equal(stores.length, 2);
  assert.deepEqual(stores.map((s) => s.name).sort(), ['Downtown', 'Riverside']);
  const me = (await owner.as('/api/auth/me')).payload;
  assert.equal(me.member.role, 'owner');
  assert.equal(me.member.account_name, 'Test Cafe');
  assert.deepEqual(me.member.store_ids.sort(), stores.map((s) => s.id).sort());
});

test('signing in is required for anything but the sign-in endpoints', async () => {
  assert.equal((await app.call('/api/products')).status, 401);
  assert.equal((await app.call('/api/dashboard')).status, 401);
  assert.equal((await app.call('/api/auth/config')).status, 200);
  const anon = (await app.call('/api/auth/me')).payload;
  assert.equal(anon.user, null);
});

test('imports a supplier spreadsheet with unfamiliar headers', async () => {
  const { status, payload } = await owner.as('/api/import/products', { method: 'POST', body: { csv: PRODUCT_CSV } });
  assert.equal(status, 200);
  assert.equal(payload.products_created, 2);
  assert.equal(payload.suppliers_created, 2);
  assert.equal(payload.links_created, 2);
  assert.equal(payload.store_rows, 3);
  assert.deepEqual(payload.errors, []);

  const products = (await owner.as('/api/products')).payload;
  assert.equal(products.length, 2);
  assert.equal(products.find((p) => p.name === 'Espresso, dark roast').suppliers[0].sku, 'BCR-1');
});

test('re-importing the same file updates rather than duplicates', async () => {
  const before = (await owner.as('/api/products')).payload.length;
  const { payload } = await owner.as('/api/import/products', { method: 'POST', body: { csv: PRODUCT_CSV } });
  assert.equal(payload.products_created, 0);
  assert.equal(payload.products_updated, 3);
  assert.equal((await owner.as('/api/products')).payload.length, before);
});

test('rejects a second product claiming a SKU another product already uses', async () => {
  const csv = 'product_name,supplier_name,sku\nSomething Else,Sysco,SY-1\n';
  const { payload } = await owner.as('/api/import/products', { method: 'POST', body: { csv } });
  assert.equal(payload.errors.length, 1);
  assert.match(payload.errors[0], /already used/);
});

test('inventory shows per-location stock, par and what is short', async () => {
  const rows = (await owner.as(`/api/inventory?store_id=${s1.id}`)).payload;
  const milk = rows.find((r) => r.product_name === 'Whole Milk');
  assert.equal(milk.on_hand, 3);
  assert.equal(milk.par_level, 12);
  assert.equal(milk.needed, 9);
  assert.equal(milk.sku, 'SY-1');

  const riverside = (await owner.as(`/api/inventory?store_id=${s2.id}`)).payload;
  assert.equal(riverside.find((r) => r.product_name === 'Whole Milk').on_hand, 8);

  const short = (await owner.as(`/api/inventory?store_id=${s1.id}&only=below_par`)).payload;
  assert.ok(short.every((r) => r.on_hand < r.par_level));
});

test('saving a count writes history and resets on hand', async () => {
  const milk = (await owner.as('/api/products?search=Whole Milk')).payload[0];
  const saved = await owner.as('/api/counts', {
    method: 'POST',
    body: { store_id: s1.id, counted_at: '2026-03-02', note: 'Monday', lines: [{ product_id: milk.id, qty: 5 }] },
  });
  assert.equal(saved.payload.saved, 1);

  const rows = (await owner.as(`/api/inventory?store_id=${s1.id}`)).payload;
  assert.equal(rows.find((r) => r.product_id === milk.id).on_hand, 5);

  const history = (await owner.as(`/api/counts?store_id=${s1.id}`)).payload;
  assert.equal(history[0].qty, 5);
  assert.equal(history[0].counted_by_email, 'owner@example.com');
});

test('a count sheet CSV imports against SKUs', async () => {
  const csv = 'store_code,sku,qty,date\nDOWN,SY-1,2,2026-03-09\nDOWN,NOPE-9,4,2026-03-09\n';
  const { payload } = await owner.as('/api/import/counts', { method: 'POST', body: { csv } });
  assert.equal(payload.counts, 1);
  assert.equal(payload.errors.length, 1);
  assert.match(payload.errors[0], /no product matches/i);

  const rows = (await owner.as(`/api/inventory?store_id=${s1.id}`)).payload;
  assert.equal(rows.find((r) => r.sku === 'SY-1').on_hand, 2);
});

test('usage appears once a product has two counts', async () => {
  const report = (await owner.as('/api/usage?from=2026-03-01&to=2026-03-31')).payload;
  assert.equal(report.rows.find((r) => r.product_name === 'Whole Milk').used, 3);
});

test('the whole order loop: suggest, save, export, send, receive', async () => {
  const sysco = (await owner.as('/api/suppliers')).payload.find((s) => s.name === 'Sysco');
  const sheet = (await owner.as('/api/orders/suggest', {
    method: 'POST', body: { store_id: s1.id, supplier_id: sysco.id, mode: 'par' },
  })).payload;
  assert.equal(sheet.lines.length, 1);
  assert.equal(sheet.lines[0].qty_packs, 3);

  const order = (await owner.as('/api/orders', {
    method: 'POST', body: { store_id: s1.id, supplier_id: sysco.id, note: 'Thursday', lines: sheet.lines },
  })).payload;
  assert.equal(order.status, 'draft');
  assert.equal(order.total, 44.4);
  assert.equal(order.created_by_email, 'owner@example.com');

  const csv = (await owner.as(`/api/orders/${order.id}/export.csv`, { raw: true })).payload;
  assert.match(csv, /Supplier SKU,Product/);
  assert.match(csv, /SY-1,Whole Milk,Dairy,3,case/);
  assert.match(csv, /ORDER TOTAL/);

  assert.equal((await owner.as(`/api/orders/${order.id}/status`, { method: 'POST', body: { status: 'sent' } })).payload.status, 'sent');
  assert.equal((await owner.as(`/api/orders/${order.id}/receive`, { method: 'POST', body: {} })).payload.status, 'received');

  const rows = (await owner.as(`/api/inventory?store_id=${s1.id}`)).payload;
  assert.equal(rows.find((r) => r.sku === 'SY-1').on_hand, 14); // 2 counted + 3 cases of 4
});

test('a delivery is stock in, and the difference either side of it is usage', async () => {
  const milk = (await owner.as('/api/products?search=Whole Milk')).payload[0];
  await owner.as('/api/counts', { method: 'POST', body: { store_id: s1.id, counted_at: '2026-04-01', lines: [{ product_id: milk.id, qty: 2 }] } });
  const booked = await owner.as('/api/receipts', {
    method: 'POST',
    body: { store_id: s1.id, product_id: milk.id, qty: 12, received_at: '2026-04-03', note: 'Walk-in buy' },
  });
  assert.equal(booked.status, 201);
  await owner.as('/api/counts', { method: 'POST', body: { store_id: s1.id, counted_at: '2026-04-08', lines: [{ product_id: milk.id, qty: 5 }] } });

  const row = (await owner.as('/api/usage?from=2026-04-01&to=2026-04-30')).payload.rows
    .find((r) => r.product_name === 'Whole Milk');
  assert.equal(row.received, 12);
  assert.equal(row.used, 9);
});

test('a supplier order sheet exports as CSV without saving an order first', async () => {
  const sysco = (await owner.as('/api/suppliers')).payload.find((s) => s.name === 'Sysco');
  const before = (await owner.as('/api/orders')).payload.length;

  const res = await owner.as(`/api/orders/sheet.csv?store_id=${s1.id}&supplier_id=${sysco.id}&mode=par`, { raw: true });
  assert.match(res.headers.get('content-disposition'), /order-sheet-sysco-down\.csv/);
  assert.match(res.payload, /# Order sheet - Sysco/);
  assert.equal((await owner.as('/api/orders')).payload.length, before, 'exporting does not raise an order');
});

test('order schedules save, come back due, and raise a draft over HTTP', async () => {
  const sysco = (await owner.as('/api/suppliers')).payload.find((s) => s.name === 'Sysco');
  const created = await owner.as('/api/schedules', {
    method: 'POST',
    body: {
      supplier_id: sysco.id, store_id: s1.id, name: 'Weekly dairy',
      frequency: 'weekly', day_of_week: new Date().getUTCDay(),
      anchor_date: '2026-01-01', mode: 'par', lead_time_days: 2,
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.status, 'due_today');

  const upcoming = (await owner.as('/api/schedules/upcoming?days=30')).payload;
  assert.ok(upcoming.length >= 4);
  assert.equal(upcoming[0].is_due, true);

  const milk = (await owner.as('/api/products?search=Whole Milk')).payload[0];
  await owner.as('/api/counts', { method: 'POST', body: { store_id: s1.id, lines: [{ product_id: milk.id, qty: 12 }] } });
  assert.equal((await owner.as(`/api/schedules/${created.payload.id}/run`, { method: 'POST', body: {} })).payload.order, null);

  await owner.as('/api/counts', { method: 'POST', body: { store_id: s1.id, lines: [{ product_id: milk.id, qty: 1 }] } });
  const forced = (await owner.as(`/api/schedules/${created.payload.id}/run`, { method: 'POST', body: { force: true } })).payload;
  assert.ok(forced.order);
  assert.equal(forced.order.items[0].sku, 'SY-1');
});

test('an invalid schedule is refused with a readable message', async () => {
  const { status, payload } = await owner.as('/api/schedules', {
    method: 'POST', body: { store_id: s1.id, frequency: 'weekly', day_of_week: 1 },
  });
  assert.equal(status, 400);
  assert.match(payload.error, /supplier and a store/);
});

test('the product export round-trips back through the importer', async () => {
  const csv = (await owner.as('/api/export/products.csv', { raw: true })).payload;
  const { payload } = await owner.as('/api/import/products', { method: 'POST', body: { csv } });
  assert.deepEqual(payload.errors, []);
  assert.equal(payload.products_created, 0);
});

test('bad requests answer with a message, not a stack trace', async () => {
  assert.equal((await owner.as('/api/inventory')).status, 400);
  assert.equal((await owner.as('/api/usage?from=2026-01-01')).status, 400);
  assert.equal((await owner.as('/api/orders/99999')).status, 404);
  assert.equal((await owner.as('/api/nope')).status, 404);
  const { status, payload } = await owner.as('/api/orders', {
    method: 'POST', body: { store_id: s1.id, supplier_id: 1, lines: [] },
  });
  assert.equal(status, 400);
  assert.match(payload.error, /at least one line/);
});

test('the dashboard summarises every location the member can see', async () => {
  const { payload } = await owner.as('/api/dashboard');
  assert.equal(payload.stores.length, 2);
  assert.ok(payload.stores.every((s) => 'below_par' in s && 'stock_value' in s));
  assert.equal(payload.account.name, 'Test Cafe');
  assert.ok(Array.isArray(payload.schedule_due));
  assert.ok(payload.counts.people >= 1);
});
