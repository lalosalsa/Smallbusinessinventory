'use strict';

const { db } = require('./db');
const { suggestOrder, createOrder, httpError } = require('./orders');

/**
 * Standing order days per supplier: "order from Sysco every Monday", "Pacific Paper
 * every second Tuesday", "Restaurant Depot on the 1st". Dates are handled as plain
 * YYYY-MM-DD in UTC so a schedule never drifts across a daylight-saving change.
 */

const DAY_MS = 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function todayIso() { return new Date().toISOString().slice(0, 10); }
function toDate(iso) { return new Date(`${iso}T00:00:00Z`); }
function toIso(date) { return date.toISOString().slice(0, 10); }
function addDays(iso, n) { return toIso(new Date(toDate(iso).getTime() + n * DAY_MS)); }
function weekday(iso) { return toDate(iso).getUTCDay(); }

/** The first scheduled date on or after `from`. */
function nextOccurrence(schedule, from = todayIso()) {
  const anchor = schedule.anchor_date || todayIso();
  const start = from < anchor ? anchor : from;

  switch (schedule.frequency) {
    case 'weekly': {
      const target = clampInt(schedule.day_of_week, 0, 6, weekday(anchor));
      return addDays(start, (target - weekday(start) + 7) % 7);
    }
    case 'biweekly': {
      // Keep the fortnightly rhythm anchored to the first order day.
      const target = clampInt(schedule.day_of_week, 0, 6, weekday(anchor));
      const firstDay = addDays(anchor, (target - weekday(anchor) + 7) % 7);
      if (start <= firstDay) return firstDay;
      const elapsed = Math.round((toDate(start) - toDate(firstDay)) / DAY_MS);
      return addDays(firstDay, Math.ceil(elapsed / 14) * 14);
    }
    case 'monthly': {
      const target = clampInt(schedule.day_of_month, 1, 31, Number(anchor.slice(8, 10)));
      const d = toDate(start);
      for (let i = 0; i < 3; i++) {
        const year = d.getUTCFullYear();
        const month = d.getUTCMonth() + i;
        const candidate = monthDay(year, month, target);
        if (candidate >= start) return candidate;
      }
      return monthDay(d.getUTCFullYear(), d.getUTCMonth() + 1, target);
    }
    case 'days': {
      const step = Math.max(1, Number(schedule.interval_days) || 7);
      if (start <= anchor) return anchor;
      const elapsed = Math.round((toDate(start) - toDate(anchor)) / DAY_MS);
      return addDays(anchor, Math.ceil(elapsed / step) * step);
    }
    default:
      throw httpError(400, `Unknown schedule frequency "${schedule.frequency}"`);
  }
}

/** Every scheduled date in a window, for the calendar view. */
function occurrencesBetween(schedule, from, to, limit = 60) {
  const out = [];
  let cursor = nextOccurrence(schedule, from);
  while (cursor <= to && out.length < limit) {
    out.push(cursor);
    cursor = nextOccurrence(schedule, addDays(cursor, 1));
  }
  return out;
}

/** Plain-English summary, e.g. "Every 2 weeks on Monday". */
function describe(schedule) {
  switch (schedule.frequency) {
    case 'weekly': return `Every ${WEEKDAYS[clampInt(schedule.day_of_week, 0, 6, 1)]}`;
    case 'biweekly': return `Every 2 weeks on ${WEEKDAYS[clampInt(schedule.day_of_week, 0, 6, 1)]}`;
    case 'monthly': return `Monthly on the ${ordinal(clampInt(schedule.day_of_month, 1, 31, 1))}`;
    case 'days': return `Every ${Math.max(1, Number(schedule.interval_days) || 7)} days`;
    default: return 'Custom';
  }
}

/**
 * Works out where a schedule stands today:
 *   due_date  - the order day it is waiting on (today or earlier), if any
 *   next_due  - the next order day still ahead
 *   status    - overdue | due_today | upcoming
 */
function scheduleStatus(schedule, today = todayIso()) {
  // Until the schedule has been acted on once, it only looks forward from the day it was
  // set up: back-dating the start date sets the rhythm, it does not raise months of
  // missed orders.
  const baseline = schedule.last_ordered_on
    ? addDays(dateOnly(schedule.last_ordered_on), 1)
    : laterOf(dateOnly(schedule.anchor_date), dateOnly(schedule.created_at));
  const pending = nextOccurrence(schedule, baseline);
  const dueNow = pending <= today;
  const nextDue = dueNow ? nextOccurrence(schedule, addDays(today, 1)) : pending;
  const leadTime = schedule.lead_time_days != null ? schedule.lead_time_days : (schedule.supplier_lead_time ?? 0);

  return {
    due_date: dueNow ? pending : null,
    next_due: nextDue,
    days_until: Math.round((toDate(nextDue) - toDate(today)) / DAY_MS),
    days_overdue: dueNow ? Math.round((toDate(today) - toDate(pending)) / DAY_MS) : 0,
    status: dueNow ? (pending < today ? 'overdue' : 'due_today') : 'upcoming',
    expected_delivery: addDays(dueNow ? pending : nextDue, leadTime),
    summary: describe(schedule),
  };
}

const SELECT_SCHEDULES = `
  SELECT sc.*, v.name AS supplier_name, v.email AS supplier_email,
         v.lead_time_days AS supplier_lead_time, v.min_order_value,
         s.name AS store_name, s.code AS store_code
  FROM order_schedules sc
  JOIN suppliers v ON v.id = sc.supplier_id
  JOIN stores s    ON s.id = sc.store_id
`;

async function listSchedules({ accountId, activeOnly = false, storeIds = null } = {}) {
  const rows = await db.all(`
    ${SELECT_SCHEDULES}
    WHERE sc.account_id = :account
      AND (:activeOnly = false OR sc.active)
      AND (:storeIds::bigint[] IS NULL OR sc.store_id = ANY(:storeIds))
    ORDER BY v.name, s.name
  `, { account: accountId, activeOnly: !!activeOnly, storeIds: storeIds && storeIds.length ? storeIds : null });

  return rows
    .map((s) => ({ ...s, ...scheduleStatus(s) }))
    .sort((a, b) => (a.due_date ? 0 : 1) - (b.due_date ? 0 : 1) || a.next_due.localeCompare(b.next_due));
}

async function getSchedule(accountId, id) {
  const row = await db.one(`${SELECT_SCHEDULES} WHERE sc.id = :id AND sc.account_id = :account`,
    { id, account: accountId });
  return row ? { ...row, ...scheduleStatus(row) } : null;
}

const WRITABLE = ['supplier_id', 'store_id', 'name', 'frequency', 'day_of_week', 'day_of_month',
  'interval_days', 'anchor_date', 'lead_time_days', 'auto_draft', 'mode', 'days_of_cover',
  'lookback_days', 'note', 'active'];

const COLUMN_PARAMS = {
  supplier_id: 'supplierId', store_id: 'storeId', name: 'name', frequency: 'frequency',
  day_of_week: 'dayOfWeek', day_of_month: 'dayOfMonth', interval_days: 'intervalDays',
  anchor_date: 'anchorDate', lead_time_days: 'leadTime', auto_draft: 'autoDraft',
  mode: 'mode', days_of_cover: 'daysOfCover', lookback_days: 'lookbackDays',
  note: 'note', active: 'active',
};

function normalise(body) {
  const payload = {
    supplierId: Number(body.supplier_id),
    storeId: Number(body.store_id),
    name: body.name || '',
    frequency: body.frequency || 'weekly',
    dayOfWeek: blankToNull(body.day_of_week),
    dayOfMonth: blankToNull(body.day_of_month),
    intervalDays: blankToNull(body.interval_days),
    anchorDate: (body.anchor_date || todayIso()).slice(0, 10),
    leadTime: blankToNull(body.lead_time_days),
    autoDraft: body.auto_draft === false || body.auto_draft === 0 ? false : true,
    mode: body.mode || 'both',
    daysOfCover: Number(body.days_of_cover) || 7,
    lookbackDays: Number(body.lookback_days) || 28,
    note: body.note || '',
    active: body.active === false || body.active === 0 ? false : true,
  };

  if (!payload.supplierId || !payload.storeId) throw httpError(400, 'A schedule needs a supplier and a store');
  if (!['weekly', 'biweekly', 'monthly', 'days'].includes(payload.frequency)) throw httpError(400, 'Unknown frequency');
  if (['weekly', 'biweekly'].includes(payload.frequency) && payload.dayOfWeek == null) {
    throw httpError(400, 'Pick the day of the week to order on');
  }
  if (payload.frequency === 'monthly' && payload.dayOfMonth == null) throw httpError(400, 'Pick the day of the month');
  if (payload.frequency === 'days' && !(payload.intervalDays > 0)) throw httpError(400, 'Set how many days apart the orders are');

  return payload;
}

function blankToNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function saveSchedule(accountId, body, id = null) {
  const payload = normalise(body);

  const supplier = await db.one('SELECT id FROM suppliers WHERE id = :id AND account_id = :account',
    { id: payload.supplierId, account: accountId });
  const store = await db.one('SELECT id FROM stores WHERE id = :id AND account_id = :account',
    { id: payload.storeId, account: accountId });
  if (!supplier) throw httpError(404, 'Supplier not found');
  if (!store) throw httpError(404, 'Location not found');

  if (id) {
    const sets = WRITABLE.map((c) => `${c} = :${COLUMN_PARAMS[c]}`).join(', ');
    const updated = await db.one(`UPDATE order_schedules SET ${sets}
      WHERE id = :id AND account_id = :account RETURNING id`, { ...payload, id, account: accountId });
    if (!updated) throw httpError(404, 'Schedule not found');
    return getSchedule(accountId, id);
  }

  const columns = ['account_id', ...WRITABLE];
  const values = [':account', ...WRITABLE.map((c) => `:${COLUMN_PARAMS[c]}`)];
  const created = await db.one(`
    INSERT INTO order_schedules (${columns.join(', ')}) VALUES (${values.join(', ')}) RETURNING id
  `, { ...payload, account: accountId });
  return getSchedule(accountId, created.id);
}

/**
 * Raises the draft order a schedule is due for, using that schedule's own suggestion
 * settings. Returns { order, sheet } - order is null when nothing needs ordering, and
 * the schedule still moves on so it does not stay stuck on a past date.
 */
async function runSchedule(accountId, id, { force = false, markOnly = false, createdBy = null } = {}) {
  const schedule = await getSchedule(accountId, id);
  if (!schedule) throw httpError(404, 'Schedule not found');

  const dueDate = schedule.due_date || (force ? schedule.next_due : null);
  if (!dueDate) throw httpError(400, `That schedule is not due until ${schedule.next_due}`);

  if (markOnly) {
    await db.run('UPDATE order_schedules SET last_ordered_on = :date WHERE id = :id', { date: dueDate, id });
    return { order: null, skipped: true, covered_date: dueDate, schedule: await getSchedule(accountId, id) };
  }

  const sheet = await suggestOrder({
    accountId,
    storeId: schedule.store_id,
    supplierId: schedule.supplier_id,
    mode: schedule.mode,
    daysOfCover: schedule.days_of_cover,
    lookbackDays: schedule.lookback_days,
    onlyNeeded: true,
  });

  if (!sheet.lines.length) {
    await db.run('UPDATE order_schedules SET last_ordered_on = :date WHERE id = :id', { date: dueDate, id });
    return { order: null, sheet, covered_date: dueDate, schedule: await getSchedule(accountId, id) };
  }

  const note = [schedule.name || describe(schedule), `scheduled for ${dueDate}`, schedule.note]
    .filter(Boolean).join(' \u2014 ');

  const order = await createOrder({
    accountId,
    storeId: schedule.store_id,
    supplierId: schedule.supplier_id,
    note,
    lines: sheet.lines,
    createdBy,
    scheduleId: id,
  });

  await db.run('UPDATE order_schedules SET last_ordered_on = :date, last_order_id = :order WHERE id = :id',
    { date: dueDate, order: order.id, id });

  return { order, sheet, covered_date: dueDate, schedule: await getSchedule(accountId, id) };
}

/** Raises drafts for every active schedule that is due and set to auto-draft. */
async function runDueSchedules(accountId, { storeIds = null, createdBy = null } = {}) {
  const all = await listSchedules({ accountId, activeOnly: true, storeIds });
  const due = all.filter((s) => s.due_date && s.auto_draft);

  const results = [];
  for (const schedule of due) {
    try {
      const run = await runSchedule(accountId, schedule.id, { createdBy });
      results.push({ schedule_id: schedule.id, supplier: schedule.supplier_name, store: schedule.store_name, ...run });
    } catch (err) {
      results.push({ schedule_id: schedule.id, supplier: schedule.supplier_name, error: err.message });
    }
  }
  return results;
}

/** The order days coming up in the next `days` days, for the calendar and dashboard. */
async function upcoming(accountId, days = 30, { storeIds = null } = {}) {
  const from = todayIso();
  const to = addDays(from, days);
  const rows = [];

  for (const schedule of await listSchedules({ accountId, activeOnly: true, storeIds })) {
    if (schedule.due_date) rows.push({ date: schedule.due_date, schedule, status: schedule.status, is_due: true });
    for (const date of occurrencesBetween(schedule, from, to)) {
      if (schedule.due_date === date) continue;
      rows.push({ date, schedule, status: 'upcoming', is_due: false });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function laterOf(a, b) { return b && b > a ? b : a; }

/** Postgres hands back DATE as a string and TIMESTAMPTZ as a Date; both end up YYYY-MM-DD. */
function dateOnly(value) {
  if (!value) return '';
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function monthDay(year, month, day) {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return toIso(new Date(Date.UTC(year, month, Math.min(day, lastDay))));
}

function ordinal(n) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${suffix}`;
}

module.exports = {
  nextOccurrence, occurrencesBetween, scheduleStatus, describe, listSchedules, getSchedule,
  saveSchedule, runSchedule, runDueSchedules, upcoming, WEEKDAYS, todayIso, addDays, normalise,
};
