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
    ? addDays(schedule.last_ordered_on, 1)
    : laterOf(schedule.anchor_date, (schedule.created_at || '').slice(0, 10));
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

function listSchedules({ activeOnly = false, storeId = null } = {}) {
  let sql = SELECT_SCHEDULES + ' WHERE 1=1';
  const params = {};
  if (activeOnly) sql += ' AND sc.active = 1';
  if (storeId) { sql += ' AND sc.store_id = @storeId'; params.storeId = Number(storeId); }
  sql += ' ORDER BY v.name, s.name';

  return db.prepare(sql).all(params)
    .map((s) => ({ ...s, ...scheduleStatus(s) }))
    .sort((a, b) => (a.due_date ? 0 : 1) - (b.due_date ? 0 : 1) || a.next_due.localeCompare(b.next_due));
}

function getSchedule(id) {
  const row = db.prepare(`${SELECT_SCHEDULES} WHERE sc.id = ?`).get(id);
  return row ? { ...row, ...scheduleStatus(row) } : null;
}

const WRITABLE = ['supplier_id', 'store_id', 'name', 'frequency', 'day_of_week', 'day_of_month',
  'interval_days', 'anchor_date', 'lead_time_days', 'auto_draft', 'mode', 'days_of_cover',
  'lookback_days', 'note', 'active'];

function saveSchedule(body, id = null) {
  const payload = {
    supplier_id: Number(body.supplier_id),
    store_id: Number(body.store_id),
    name: body.name || '',
    frequency: body.frequency || 'weekly',
    day_of_week: body.day_of_week === '' || body.day_of_week == null ? null : Number(body.day_of_week),
    day_of_month: body.day_of_month === '' || body.day_of_month == null ? null : Number(body.day_of_month),
    interval_days: body.interval_days === '' || body.interval_days == null ? null : Number(body.interval_days),
    anchor_date: (body.anchor_date || todayIso()).slice(0, 10),
    lead_time_days: body.lead_time_days === '' || body.lead_time_days == null ? null : Number(body.lead_time_days),
    auto_draft: body.auto_draft === false || body.auto_draft === 0 ? 0 : 1,
    mode: body.mode || 'both',
    days_of_cover: Number(body.days_of_cover) || 7,
    lookback_days: Number(body.lookback_days) || 28,
    note: body.note || '',
    active: body.active === false || body.active === 0 ? 0 : 1,
  };

  if (!payload.supplier_id || !payload.store_id) throw httpError(400, 'A schedule needs a supplier and a store');
  if (!['weekly', 'biweekly', 'monthly', 'days'].includes(payload.frequency)) throw httpError(400, 'Unknown frequency');
  if (['weekly', 'biweekly'].includes(payload.frequency) && payload.day_of_week == null) {
    throw httpError(400, 'Pick the day of the week to order on');
  }
  if (payload.frequency === 'monthly' && payload.day_of_month == null) throw httpError(400, 'Pick the day of the month');
  if (payload.frequency === 'days' && !(payload.interval_days > 0)) throw httpError(400, 'Set how many days apart the orders are');

  if (id) {
    db.prepare(`UPDATE order_schedules SET ${WRITABLE.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
      .run({ ...payload, id: Number(id) });
    return getSchedule(id);
  }
  const newId = db.prepare(`INSERT INTO order_schedules (${WRITABLE.join(', ')})
    VALUES (${WRITABLE.map((c) => '@' + c).join(', ')})`).run(payload).lastInsertRowid;
  return getSchedule(newId);
}

/**
 * Raises the draft order a schedule is due for, using that schedule's own suggestion
 * settings. Returns { order, sheet } — order is null when nothing needs ordering, and
 * the schedule still moves on so it does not stay stuck on a past date.
 */
function runSchedule(id, { force = false, markOnly = false } = {}) {
  const schedule = getSchedule(id);
  if (!schedule) throw httpError(404, 'Schedule not found');

  const dueDate = schedule.due_date || (force ? schedule.next_due : null);
  if (!dueDate) throw httpError(400, `That schedule is not due until ${schedule.next_due}`);

  if (markOnly) {
    db.prepare('UPDATE order_schedules SET last_ordered_on = ? WHERE id = ?').run(dueDate, id);
    return { order: null, skipped: true, covered_date: dueDate, schedule: getSchedule(id) };
  }

  const sheet = suggestOrder({
    storeId: schedule.store_id,
    supplierId: schedule.supplier_id,
    mode: schedule.mode,
    daysOfCover: schedule.days_of_cover,
    lookbackDays: schedule.lookback_days,
    onlyNeeded: true,
  });

  if (!sheet.lines.length) {
    db.prepare('UPDATE order_schedules SET last_ordered_on = ? WHERE id = ?').run(dueDate, id);
    return { order: null, sheet, covered_date: dueDate, schedule: getSchedule(id) };
  }

  const note = [schedule.name || describe(schedule), `scheduled for ${dueDate}`, schedule.note]
    .filter(Boolean).join(' — ');
  const order = createOrder({
    storeId: schedule.store_id,
    supplierId: schedule.supplier_id,
    note,
    lines: sheet.lines,
  });
  db.prepare('UPDATE orders SET schedule_id = ? WHERE id = ?').run(id, order.id);
  db.prepare('UPDATE order_schedules SET last_ordered_on = ?, last_order_id = ? WHERE id = ?')
    .run(dueDate, order.id, id);

  return { order, sheet, covered_date: dueDate, schedule: getSchedule(id) };
}

/** Raises drafts for every active schedule that is due and set to auto-draft. */
function runDueSchedules() {
  const due = listSchedules({ activeOnly: true }).filter((s) => s.due_date && s.auto_draft);
  return due.map((s) => {
    try { return { schedule_id: s.id, supplier: s.supplier_name, store: s.store_name, ...runSchedule(s.id) }; }
    catch (err) { return { schedule_id: s.id, supplier: s.supplier_name, error: err.message }; }
  });
}

/** The order days coming up in the next `days` days, for the calendar and dashboard. */
function upcoming(days = 30) {
  const from = todayIso();
  const to = addDays(from, days);
  const rows = [];
  for (const schedule of listSchedules({ activeOnly: true })) {
    if (schedule.due_date) {
      rows.push({ date: schedule.due_date, schedule, status: schedule.status, is_due: true });
    }
    for (const date of occurrencesBetween(schedule, from, to)) {
      if (schedule.due_date === date) continue;
      rows.push({ date, schedule, status: 'upcoming', is_due: false });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function laterOf(a, b) { return b && b > a ? b : a; }

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
  saveSchedule, runSchedule, runDueSchedules, upcoming, WEEKDAYS, todayIso, addDays,
};
