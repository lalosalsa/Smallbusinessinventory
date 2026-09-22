'use strict';

const { db, resetDatabase, close } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const {
  nextOccurrence, occurrencesBetween, describe, scheduleStatus,
  saveSchedule, runSchedule, runDueSchedules, listSchedules,
} = require('../src/schedules');

const weekly = { frequency: 'weekly', day_of_week: 1, anchor_date: '2026-03-01' };      // Mondays
const biweekly = { frequency: 'biweekly', day_of_week: 2, anchor_date: '2026-03-01' };  // every other Tuesday
const monthly = { frequency: 'monthly', day_of_month: 31, anchor_date: '2026-01-01' };
const everyTen = { frequency: 'days', interval_days: 10, anchor_date: '2026-03-01' };

before(async () => { await resetDatabase(); });
after(async () => { await close(); });

/* ------------------------------------------------------------- date maths */

test('a weekly schedule lands on the chosen weekday', () => {
  assert.equal(nextOccurrence(weekly, '2026-03-04'), '2026-03-09');
  assert.equal(nextOccurrence(weekly, '2026-03-09'), '2026-03-09');
  assert.equal(nextOccurrence(weekly, '2026-03-10'), '2026-03-16');
});

test('a fortnightly schedule keeps its rhythm rather than drifting', () => {
  assert.equal(nextOccurrence(biweekly, '2026-03-01'), '2026-03-03');
  assert.equal(nextOccurrence(biweekly, '2026-03-04'), '2026-03-17');
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

test('the order day itself reads as due today, with delivery from lead time', () => {
  const status = scheduleStatus({ ...weekly, last_ordered_on: '2026-03-02', lead_time_days: 2 }, '2026-03-09');
  assert.equal(status.status, 'due_today');
  assert.equal(status.expected_delivery, '2026-03-11');
});

test('once acted on, the schedule looks ahead instead of back', () => {
  const status = scheduleStatus({ ...weekly, last_ordered_on: '2026-03-09' }, '2026-03-09');
  assert.equal(status.status, 'upcoming');
  assert.equal(status.due_date, null);
  assert.equal(status.days_until, 7);
});

test('Postgres date and timestamp shapes are both understood', () => {
  const status = scheduleStatus({
    frequency: 'weekly', day_of_week: 1, anchor_date: '2026-03-01',
    created_at: new Date('2026-03-01T10:00:00Z'), last_ordered_on: '2026-03-02',
  }, '2026-03-05');
  assert.equal(status.next_due, '2026-03-09');
});

/* ---------------------------------------------------- against the database */

let accountId;
let storeId;
let supplierId;
let productId;

async function fixture() {
  await db.run('TRUNCATE accounts CASCADE');
  accountId = (await db.one("INSERT INTO accounts (name) VALUES ('Test') RETURNING *")).id;
  storeId = (await db.one("INSERT INTO stores (account_id, name, code) VALUES (:a, 'Downtown', 'S1') RETURNING *", { a: accountId })).id;
  supplierId = (await db.one("INSERT INTO suppliers (account_id, name, lead_time_days) VALUES (:a, 'Acme', 2) RETURNING *", { a: accountId })).id;
  productId = (await db.one("INSERT INTO products (account_id, name, base_unit) VALUES (:a, 'Milk', 'gal') RETURNING *", { a: accountId })).id;
  await db.run(`INSERT INTO product_suppliers (account_id, product_id, supplier_id, sku, pack_size, unit_cost, is_primary)
                VALUES (:a, :p, :s, 'SKU-1', 4, 20, true)`, { a: accountId, p: productId, s: supplierId });
  await db.run('INSERT INTO store_products (account_id, store_id, product_id, par_level, on_hand) VALUES (:a, :s, :p, 12, 2)',
    { a: accountId, s: storeId, p: productId });
}

const dueToday = (extra = {}) => saveSchedule(accountId, {
  supplier_id: supplierId, store_id: storeId, frequency: 'weekly',
  day_of_week: new Date().getUTCDay(), anchor_date: '2026-01-01', mode: 'par', ...extra,
});

test('saving a schedule validates the fields its frequency needs', async () => {
  await fixture();
  await assert.rejects(() => saveSchedule(accountId, { supplier_id: supplierId, store_id: storeId, frequency: 'weekly' }), /day of the week/);
  await assert.rejects(() => saveSchedule(accountId, { supplier_id: supplierId, store_id: storeId, frequency: 'monthly' }), /day of the month/);
  await assert.rejects(() => saveSchedule(accountId, { supplier_id: supplierId, store_id: storeId, frequency: 'days' }), /days apart/);
  await assert.rejects(() => saveSchedule(accountId, { supplier_id: supplierId, store_id: storeId, frequency: 'yearly', day_of_week: 1 }), /Unknown frequency/);
  await assert.rejects(() => saveSchedule(accountId, { store_id: storeId, frequency: 'weekly', day_of_week: 1 }), /supplier and a store/);
});

test('a schedule cannot point at another account\'s supplier', async () => {
  await fixture();
  const other = await db.one("INSERT INTO accounts (name) VALUES ('Other') RETURNING *");
  const theirSupplier = await db.one("INSERT INTO suppliers (account_id, name) VALUES (:a, 'Theirs') RETURNING *", { a: other.id });
  await assert.rejects(
    () => saveSchedule(accountId, { supplier_id: theirSupplier.id, store_id: storeId, frequency: 'weekly', day_of_week: 1 }),
    /Supplier not found/,
  );
});

test('a due schedule raises a draft order and then stops asking', async () => {
  await fixture();
  const schedule = await dueToday();
  assert.equal(schedule.status, 'due_today');

  const { order, covered_date } = await runSchedule(accountId, schedule.id);
  assert.ok(order);
  assert.equal(order.status, 'draft');
  assert.equal(order.items[0].qty_packs, 3);
  assert.match(order.note, /scheduled for/);
  assert.equal(covered_date, schedule.due_date);

  const after = (await listSchedules({ accountId }))[0];
  assert.equal(after.due_date, null);
  assert.equal(after.last_order_id, order.id);
  assert.equal((await db.one('SELECT schedule_id FROM orders WHERE id = :id', { id: order.id })).schedule_id, schedule.id);
});

test('a schedule that is not due can be run early but not by accident', async () => {
  await fixture();
  const schedule = await saveSchedule(accountId, {
    supplier_id: supplierId, store_id: storeId, frequency: 'weekly',
    day_of_week: (new Date().getUTCDay() + 1) % 7, anchor_date: '2026-01-01', mode: 'par',
  });
  assert.equal(schedule.status, 'upcoming');
  await assert.rejects(() => runSchedule(accountId, schedule.id), /not due until/);
  assert.ok((await runSchedule(accountId, schedule.id, { force: true })).order);
});

test('skipping an order day moves the schedule on without raising an order', async () => {
  await fixture();
  const schedule = await dueToday();
  const res = await runSchedule(accountId, schedule.id, { markOnly: true });
  assert.equal(res.order, null);
  assert.equal(res.skipped, true);
  assert.equal(await db.value('SELECT count(*)::int FROM orders'), 0);
  assert.equal((await listSchedules({ accountId }))[0].due_date, null);
});

test('a due schedule with nothing below par raises no order and still moves on', async () => {
  await fixture();
  await db.run('UPDATE store_products SET on_hand = par_level');
  const schedule = await dueToday();
  assert.equal((await runSchedule(accountId, schedule.id)).order, null);
  assert.equal((await listSchedules({ accountId }))[0].due_date, null);
});

test('a schedule set up with a back-dated start is not instantly overdue', async () => {
  await fixture();
  const schedule = await saveSchedule(accountId, {
    supplier_id: supplierId, store_id: storeId, frequency: 'weekly',
    day_of_week: (new Date().getUTCDay() + 3) % 7, anchor_date: '2024-01-01',
  });
  assert.equal(schedule.status, 'upcoming');
  assert.ok(schedule.days_until > 0 && schedule.days_until <= 7);
});

test('inactive schedules and auto-draft opt-outs stay out of the bulk run', async () => {
  await fixture();
  await dueToday({ active: false });
  assert.deepEqual(await runDueSchedules(accountId), []);

  await db.run('TRUNCATE order_schedules CASCADE');
  const optedOut = await dueToday({ auto_draft: false });
  assert.deepEqual(await runDueSchedules(accountId), []);
  assert.equal((await listSchedules({ accountId }))[0].id, optedOut.id);
  assert.equal((await listSchedules({ accountId }))[0].status, 'due_today');
});

test('the bulk run raises a draft for every due schedule', async () => {
  await fixture();
  await dueToday();
  const runs = await runDueSchedules(accountId);
  assert.equal(runs.length, 1);
  assert.ok(runs[0].order);
});
