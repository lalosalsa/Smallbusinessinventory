'use strict';

const { db } = require('./db');

/**
 * Usage is inferred from stock movement, so it needs no till integration:
 *
 *   usage between two counts = earlier count + everything received in between - later count
 *
 * Every consecutive pair of counts for a (store, product) is one segment. A segment
 * belongs to the reporting window when its closing count falls inside the window, so a
 * count taken on the last day of a month is attributed to that month.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function iso(value) {
  if (!value) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

function dayKey(ts) { return iso(ts).slice(0, 10); }
function monthKey(ts) { return iso(ts).slice(0, 7); }

function weekKey(ts) {
  // ISO week (Mon-Sun), rendered as 2026-W13.
  const d = new Date(`${dayKey(ts)}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function bucketKey(ts, groupBy) {
  if (groupBy === 'day') return dayKey(ts);
  if (groupBy === 'week') return weekKey(ts);
  if (groupBy === 'month') return monthKey(ts);
  return 'total';
}

function windowBounds(from, to) {
  return { start: `${from}T00:00:00.000Z`, end: `${to}T23:59:59.999Z` };
}

/**
 * Builds usage segments for the window.
 * Returns { store_id, product_id, from, to, opening, received, closing, used }.
 */
async function usageSegments({ accountId, from, to, storeId = null, productId = null, storeIds = null }) {
  const { start, end } = windowBounds(from, to);
  const params = {
    account: accountId,
    storeId: storeId ? Number(storeId) : null,
    productId: productId ? Number(productId) : null,
    storeIds: storeIds && storeIds.length ? storeIds : null,
  };

  const scope = `
    AND (:storeId::bigint IS NULL OR store_id = :storeId)
    AND (:storeIds::bigint[] IS NULL OR store_id = ANY(:storeIds))
    AND (:productId::bigint IS NULL OR product_id = :productId)
  `;

  const counts = await db.all(`
    SELECT store_id, product_id, qty, counted_at
    FROM counts
    WHERE account_id = :account ${scope}
    ORDER BY store_id, product_id, counted_at, id
  `, params);

  const receipts = await db.all(`
    SELECT store_id, product_id, qty, received_at
    FROM receipts
    WHERE account_id = :account ${scope}
    ORDER BY store_id, product_id, received_at
  `, params);

  const receiptsByKey = new Map();
  for (const r of receipts) {
    const key = `${r.store_id}:${r.product_id}`;
    if (!receiptsByKey.has(key)) receiptsByKey.set(key, []);
    receiptsByKey.get(key).push({ ...r, at: iso(r.received_at) });
  }

  const countsByKey = new Map();
  for (const c of counts) {
    const key = `${c.store_id}:${c.product_id}`;
    if (!countsByKey.has(key)) countsByKey.set(key, []);
    countsByKey.get(key).push({ ...c, at: iso(c.counted_at) });
  }

  const segments = [];
  for (const [key, list] of countsByKey) {
    const received = receiptsByKey.get(key) || [];
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const next = list[i];
      if (next.at < start || next.at > end) continue;
      const receivedQty = received
        .filter((r) => r.at > prev.at && r.at <= next.at)
        .reduce((sum, r) => sum + Number(r.qty), 0);
      const used = Number(prev.qty) + receivedQty - Number(next.qty);
      segments.push({
        store_id: next.store_id,
        product_id: next.product_id,
        from: prev.at,
        to: next.at,
        opening: Number(prev.qty),
        received: receivedQty,
        closing: Number(next.qty),
        // Negative means more was counted than could have arrived: a miscount or an
        // unrecorded delivery. It is clamped so it cannot cancel out real usage.
        used: Math.max(0, used),
        raw_used: used,
      });
    }
  }
  return segments;
}

/** Usage rolled up per product, optionally bucketed by day/week/month. */
async function usageReport({ accountId, from, to, storeId = null, productId = null, storeIds = null, groupBy = 'total', category = null }) {
  const segments = await usageSegments({ accountId, from, to, storeId, productId, storeIds });

  const [productRows, storeRows, costRows] = await Promise.all([
    db.all('SELECT id, name, category, base_unit FROM products WHERE account_id = :account', { account: accountId }),
    db.all('SELECT id, name, code FROM stores WHERE account_id = :account', { account: accountId }),
    db.all(`
      SELECT product_id, MIN(unit_cost / NULLIF(pack_size, 0)) AS unit_cost
      FROM product_suppliers WHERE account_id = :account GROUP BY product_id
    `, { account: accountId }),
  ]);

  const products = new Map(productRows.map((p) => [p.id, p]));
  const stores = new Map(storeRows.map((s) => [s.id, s]));
  const cost = new Map(costRows.map((r) => [r.product_id, Number(r.unit_cost) || 0]));

  const rows = new Map();
  const buckets = new Set();

  for (const seg of segments) {
    const product = products.get(seg.product_id);
    if (!product) continue;
    if (category && (product.category || '') !== category) continue;

    const key = `${seg.store_id}:${seg.product_id}`;
    if (!rows.has(key)) {
      rows.set(key, {
        store_id: seg.store_id,
        store_name: stores.get(seg.store_id)?.name || '',
        product_id: seg.product_id,
        product_name: product.name,
        category: product.category || '',
        base_unit: product.base_unit,
        used: 0,
        received: 0,
        segments: 0,
        buckets: {},
        est_cost: 0,
      });
    }
    const row = rows.get(key);
    row.used += seg.used;
    row.received += seg.received;
    row.segments += 1;

    const bk = bucketKey(seg.to, groupBy);
    buckets.add(bk);
    row.buckets[bk] = (row.buckets[bk] || 0) + seg.used;
  }

  const days = Math.max(1, Math.round((new Date(`${to}T23:59:59Z`) - new Date(`${from}T00:00:00Z`)) / DAY_MS));
  for (const row of rows.values()) {
    row.used = round(row.used);
    row.received = round(row.received);
    row.per_day = round(row.used / days, 3);
    row.per_week = round((row.used / days) * 7, 2);
    row.per_month = round((row.used / days) * 30, 2);
    row.est_cost = round(row.used * (cost.get(row.product_id) || 0), 2);
    for (const k of Object.keys(row.buckets)) row.buckets[k] = round(row.buckets[k]);
  }

  const list = [...rows.values()].sort((a, b) => b.used - a.used || a.product_name.localeCompare(b.product_name));

  return {
    from,
    to,
    days,
    group_by: groupBy,
    buckets: [...buckets].sort(),
    rows: list,
    totals: {
      used: round(list.reduce((s, r) => s + r.used, 0)),
      est_cost: round(list.reduce((s, r) => s + r.est_cost, 0), 2),
      products: list.length,
    },
  };
}

/** Average daily usage per product over a lookback window, for order suggestions. */
async function averageDailyUsage({ accountId, storeId, lookbackDays = 28 }) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - lookbackDays * DAY_MS).toISOString().slice(0, 10);
  const segments = await usageSegments({ accountId, from, to, storeId });

  const totals = new Map();
  for (const seg of segments) {
    const span = Math.max(1, (new Date(seg.to) - new Date(seg.from)) / DAY_MS);
    const current = totals.get(seg.product_id) || { used: 0, days: 0 };
    current.used += seg.used;
    current.days += span;
    totals.set(seg.product_id, current);
  }

  const out = new Map();
  for (const [productId, v] of totals) out.set(productId, v.days > 0 ? v.used / v.days : 0);
  return out;
}

function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

module.exports = { usageSegments, usageReport, averageDailyUsage, bucketKey, weekKey, monthKey, round, iso, DAY_MS };
