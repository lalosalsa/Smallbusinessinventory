'use strict';

require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const { nextOccurrence, occurrencesBetween, describe, scheduleStatus, saveSchedule, runSchedule, listSchedules } = require('../src/schedules');

const weekly = { frequency: 'weekly', day_of_week: 1, anchor_date: '2026-03-01' };      // Mondays
const biweekly = { frequency: 'biweekly', day_of_week: 2, anchor_date: '2026-03-01' };  // every other Tuesday
const monthly = { frequency: 'monthly', day_of_month: 31, anchor_date: '2026-01-01' };
const everyTen = { frequency: 'days', interval_days: 10, anchor_date: '2026-03-01' };

test('a weekly schedule lands on the chosen weekday', () => {
  assert.equal(nextOccurrence(weekly, '2026-03-04'), '2026-03-09'); // Wed -> next Mon
  assert.equal(nextOccurrence(weekly, '2026-03-09'), '2026-03-09'); // the day itself counts
  assert.equal(nextOccurrence(weekly, '2026-03-10'), '2026-03-16');
});

test('a fortnightly schedule keeps its rhythm rather than drifting', () => {
  const first = nextOccurrence(biweekly, '2026-03-01');
  assert.equal(first, '2026-03-03');                                // the first Tuesday
  assert.equal(nextOccurrence(biweekly, '2026-03-04'), '2026-03-17'); // skips 03-10
  assert.equal(nextOccurrence(biweekly, '2026-03-17'), '2026-03-17');
  assert.equal(nextOccurrence(biweekly, '2026-03-18'), '2026-03-31');
});

test('a monthly schedule on the 31st uses the last day of a short month', () => {
  assert.equal(nextOccurrence(monthly, '2026-02-01'), '2026-02-28');
  assert.equal(nextOccurrence(monthly, '2026-03-01'), '2026-03-31');
  assert.equal(nextOccurrence(monthly, '2026-04-01'), '2026-04-30');
  assert.equal(nextOccurrence({ ...monthly, day_of_month: 1 }, '2026-03-02'), '2026-04-01');
});

test('a custom cadence counts forward from its start date', () => {
  assert.equal(nextOccurrence(everyTen, '2026-03-01'), '2026-03-01');
  assert.equal(nextOccurrence(everyTen, '2026-03-02'), '2026-03-11');
  assert.equal(nextOccurrence(everyTen, '2026-03-21'), '2026-03-21');
});

test('a schedule never fires before its start date', () => {
  assert.equal(nextOccurrence(weekly, '2026-01-01'), '2026-03-02');
});

test('a month of occurrences lists every order day in order', () => {
  assert.deepEqual(occurrencesBetween(weekly, '2026-03-01', '2026-03-31'),
    ['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30']);
  assert.deepEqual(occurrencesBetween(biweekly, '2026-03-01', '2026-03-31'),
    ['2026-03-03', '2026-03-17', '2026-03-31']);
});

test('schedules read back in plain English', () => {
  assert.equal(describe(weekly), 'Every Monday');
  assert.equal(describe(biweekly), 'Every 2 weeks on Tuesday');
  assert.equal(describe({ frequency: 'monthly', day_of_month: 3 }), 'Monthly on the 3rd');
  assert.equal(describe(everyTen), 'Every 10 days');
});

test('a passed order day reads as overdue until it is acted on', () => {
  const status = scheduleStatus({ ...weekly, last_ordered_on: '2026-03-02' }, '2026-03-12');
  assert.equal(status.status, 'overdue');
  assert.equal(status.due_date, '2026-03-09');
  assert.equal(status.days_overdue, 3);
  assert.equal(status.next_due, '2026-03-16');
});

test('the order day itself reads as due today, with the delivery date from lead time', () => {
  const status = scheduleStatus({ ...weekly, last_ordered_on: '2026-03-02', lead_time_days: 2 }, '2026-03-09');
  assert.equal(status.status, 'due_today');
  assert.equal(status.due_date, '2026-03-09');
  assert.equal(status.expected_delivery, '2026-03-11');
});

test('once acted on, the schedule looks ahead instead of back', () => {
  const status = scheduleStatus({ ...weekly, last_ordered_on: '2026-03-09' }, '2026-03-09');
  assert.equal(status.status, 'upcoming');
  assert.equal(status.due_date, null);
  assert.equal(status.next_due, '2026-03-16');
  assert.equal(status.days_until, 7);
});

/* ------------------------------------------------ against the database ---- */

function fixture() {
  db.exec(`DELETE FROM order_items; DELETE FROM orders; DELETE FROM order_schedules; DELETE FROM store_products;
           DELETE FROM product_suppliers; DELETE FROM products; DELETE FROM suppliers;`);
  const storeId = db.prepare('SELECT id FROM stores ORDER BY id').get().id;
  const supplierId = db.prepare("INSERT INTO suppliers (name, lead_time_days) VALUES ('Acme', 2)").run().lastInsertRowid;
  const productId = db.prepare("INSERT INTO products (name, base_unit) VALUES ('Milk', 'gal')").run().lastInsertRowid;
  db.prepare(`INSERT INTO product_suppliers (product_id, supplier_id, sku, pack_size, unit_cost, is_primary)
              VALUES (?, ?, 'SKU-1', 4, 20, 1)`).run(productId, supplierId);
  db.prepare('INSERT INTO store_products (store_id, product_id, par_level, on_hand) VALUES (?, ?, 12, 2)')
    .run(storeId, productId);
  return { storeId, supplierId, productId };
}

test('saving a schedule validates the fields its frequency needs', () => {
  const { storeId, supplierId } = fixture();
  assert.throws(() => saveSchedule({ supplier_id: supplierId, store_id: storeId, frequency: 'weekly' }), /day of the week/);
  assert.throws(() => saveSchedule({ supplier_id: supplierId, store_id: storeId, frequency: 'monthly' }), /day of the month/);
  assert.throws(() => saveSchedule({ supplier_id: supplierId, store_id: storeId, frequency: 'days' }), /days apart/);
  assert.throws(() => saveSchedule({ supplier_id: supplierId, store_id: storeId, frequency: 'yearly', day_of_week: 1 }), /Unknown frequency/);
  assert.throws(() => saveSchedule({ store_id: storeId, frequency: 'weekly', day_of_week: 1 }), /supplier and a store/);
});

test('a due schedule raises a draft order and then stops asking', () => {
  const { storeId, supplierId } = fixture();
  const schedule = saveSchedule({
    supplier_id: supplierId, store_id: storeId, frequency: 'weekly',
    day_of_week: new Date().getUTCDay(), anchor_date: '2026-01-01', mode: 'par',
  });
  assert.equal(schedule.status, 'due_today');

  const { order, covered_date } = runSchedule(schedule.id);
  assert.ok(order, 'a draft order was raised');
  assert.equal(order.status, 'draft');
  assert.equal(order.items[0].qty_packs, 3);            // short 10 gal, 4 per case
  assert.match(order.note, /scheduled for/);
  assert.equal(covered_date, schedule.due_date);

  const after = listSchedules()[0];
  assert.equal(after.due_date, null, 'the schedule is no longer asking');
  assert.equal(after.last_order_id, order.id);
  assert.equal(db.prepare('SELECT schedule_id FROM orders WHERE id = ?').get(order.id).schedule_id, schedule.id);
});

test('a schedule that is not due can be run early but not by accident', () => {
  const { storeId, supplierId } = fixture();
  const tomorrow = new Date(Date.now() + 86400000).getUTCDay();
  const schedule = saveSchedule({
    supplier_id: supplierId, store_id: storeId, frequency: 'weekly',
    day_of_week: tomorrow, anchor_date: '2026-01-01', mode: 'par',
  });
  assert.equal(schedule.status, 'upcoming');
  assert.throws(() => runSchedule(schedule.id), /not due until/);
  assert.ok(runSchedule(schedule.id, { force: true }).order);
});

test('skipping an order day moves the schedule on without raising an order', () => {
  const { storeId, supplierId } = fixture();
  const schedule = saveSchedule({
    supplier_id: supplierId, store_id: storeId, frequency: 'weekly',
    day_of_week: new Date().getUTCDay(), anchor_date: '2026-01-01',
  });
  const res = runSchedule(schedule.id, { markOnly: true });
  assert.equal(res.order, null);
  assert.equal(res.skipped, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
  assert.equal(listSchedules()[0].due_date, null);
});

test('a due schedule with nothing below par raises no order and still moves on', () => {
  const { storeId, supplierId, productId } = fixture();
  db.prepare('UPDATE store_products SET on_hand = par_level WHERE product_id = ?').run(productId);
  const schedule = saveSchedule({
    supplier_id: supplierId, store_id: storeId, frequency: 'weekly',
    day_of_week: new Date().getUTCDay(), anchor_date: '2026-01-01', mode: 'par',
  });
  const res = runSchedule(schedule.id);
  assert.equal(res.order, null);
  assert.equal(listSchedules()[0].due_date, null);
});

test('a schedule set up with a back-dated start is not instantly overdue', () => {
  const { storeId, supplierId } = fixture();
  const notToday = (new Date().getUTCDay() + 3) % 7;
  const schedule = saveSchedule({
    supplier_id: supplierId, store_id: storeId, frequency: 'weekly',
    day_of_week: notToday, anchor_date: '2024-01-01',
  });
  assert.equal(schedule.status, 'upcoming');
  assert.ok(schedule.days_until > 0 && schedule.days_until <= 7);
});

test('an inactive schedule is left out of the due run', () => {
  const { storeId, supplierId } = fixture();
  saveSchedule({
    supplier_id: supplierId, store_id: storeId, frequency: 'weekly',
    day_of_week: new Date().getUTCDay(), anchor_date: '2026-01-01', mode: 'par', active: false,
  });
  const { runDueSchedules } = require('../src/schedules');
  assert.deepEqual(runDueSchedules(), []);
});

test('auto_draft off keeps a schedule out of the bulk run but still visible', () => {
  const { storeId, supplierId } = fixture();
  const schedule = saveSchedule({
    supplier_id: supplierId, store_id: storeId, frequency: 'weekly',
    day_of_week: new Date().getUTCDay(), anchor_date: '2026-01-01', mode: 'par', auto_draft: false,
  });
  const { runDueSchedules } = require('../src/schedules');
  assert.deepEqual(runDueSchedules(), []);
  assert.equal(listSchedules()[0].id, schedule.id);
  assert.equal(listSchedules()[0].status, 'due_today');
});
