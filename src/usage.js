'use strict';

const { db } = require('./db');

/**
 * Usage is inferred from stock movement, so it needs no POS integration:
 *
 *   usage between two counts = earlier count + everything received in between - later count
 *
 * Every consecutive pair of counts for a (store, product) is one segment. A segment
 * belongs to the reporting window when its closing count falls inside the window, so a
 * count taken on the last day of a month is attributed to that month.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function toIso(d) { return new Date(d).toISOString().slice(0, 19).replace('T', ' '); }
function dayKey(ts) { return String(ts).slice(0, 10); }

function weekKey(ts) {
  // ISO week (Mon-Sun), rendered as 2026-W13.
  const d = new Date(`${dayKey(ts)}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function monthKey(ts) { return String(ts).slice(0, 7); }

function bucketKey(ts, groupBy) {
  if (groupBy === 'day') return dayKey(ts);
  if (groupBy === 'week') return weekKey(ts);
  if (groupBy === 'month') return monthKey(ts);
  return 'total';
}

/**
 * Builds usage segments for the window, optionally filtered to one store or product.
 * Returns raw segments: { store_id, product_id, from, to, opening, received, closing, used }.
 */
function usageSegments({ from, to, storeId = null, productId = null }) {
  const params = { from: `${from} 00:00:00`, to: `${to} 23:59:59` };
  let where = 'WHERE 1=1';
  if (storeId) { where += ' AND c.store_id = @storeId'; params.storeId = Number(storeId); }
  if (productId) { where += ' AND c.product_id = @productId'; params.productId = Number(productId); }

  // Pull every count from one segment before the window so the first in-window
  // segment has an opening count to measure against.
  const counts = db.prepare(`
    SELECT c.store_id, c.product_id, c.qty, c.counted_at
    FROM counts c
    ${where}
    ORDER BY c.store_id, c.product_id, c.counted_at, c.id
  `).all(params);

  const receiptRows = db.prepare(`
    SELECT store_id, product_id, qty, received_at FROM receipts
    ORDER BY store_id, product_id, received_at
  `).all();

  const receiptsByKey = new Map();
  for (const r of receiptRows) {
    const k = `${r.store_id}:${r.product_id}`;
    if (!receiptsByKey.has(k)) receiptsByKey.set(k, []);
    receiptsByKey.get(k).push(r);
  }

  const byKey = new Map();
  for (const c of counts) {
    const k = `${c.store_id}:${c.product_id}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }

  const segments = [];
  for (const [k, list] of byKey) {
    const received = receiptsByKey.get(k) || [];
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const next = list[i];
      if (next.counted_at < params.from || next.counted_at > params.to) continue;
      const receivedQty = received
        .filter((r) => r.received_at > prev.counted_at && r.received_at <= next.counted_at)
        .reduce((sum, r) => sum + r.qty, 0);
      const used = prev.qty + receivedQty - next.qty;
      segments.push({
        store_id: next.store_id,
        product_id: next.product_id,
        from: prev.counted_at,
        to: next.counted_at,
        opening: prev.qty,
        received: receivedQty,
        closing: next.qty,
        // Negative means more was counted than could have arrived: a miscount or an
        // unrecorded delivery. It is clamped so it cannot cancel out real usage.
        used: Math.max(0, used),
        raw_used: used,
      });
    }
  }
  return segments;
}

/** Usage rolled up per product (and optionally bucketed by day/week/month). */
function usageReport({ from, to, storeId = null, productId = null, groupBy = 'total', category = null }) {
  const segments = usageSegments({ from, to, storeId, productId });

  const products = new Map(db.prepare('SELECT id, name, category, base_unit FROM products').all().map((p) => [p.id, p]));
  const stores = new Map(db.prepare('SELECT id, name, code FROM stores').all().map((s) => [s.id, s]));
  const cost = new Map(db.prepare(`
    SELECT product_id, MIN(unit_cost / NULLIF(pack_size, 0)) AS unit_cost
    FROM product_suppliers GROUP BY product_id
  `).all().map((r) => [r.product_id, r.unit_cost || 0]));

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

  const sortedBuckets = [...buckets].sort();
  const list = [...rows.values()].sort((a, b) => b.used - a.used || a.product_name.localeCompare(b.product_name));

  return {
    from,
    to,
    days,
    group_by: groupBy,
    buckets: sortedBuckets,
    rows: list,
    totals: {
      used: round(list.reduce((s, r) => s + r.used, 0)),
      est_cost: round(list.reduce((s, r) => s + r.est_cost, 0), 2),
      products: list.length,
    },
  };
}

/** Average daily usage per (store, product) over a lookback window, for order suggestions. */
function averageDailyUsage({ storeId, lookbackDays = 28 }) {
  const to = toIso(Date.now()).slice(0, 10);
  const from = toIso(Date.now() - lookbackDays * DAY_MS).slice(0, 10);
  const segments = usageSegments({ from, to, storeId });
  const map = new Map();
  for (const seg of segments) {
    const span = Math.max(1, (new Date(seg.to.replace(' ', 'T') + 'Z') - new Date(seg.from.replace(' ', 'T') + 'Z')) / DAY_MS);
    const cur = map.get(seg.product_id) || { used: 0, days: 0 };
    cur.used += seg.used;
    cur.days += span;
    map.set(seg.product_id, cur);
  }
  const out = new Map();
  for (const [productId, v] of map) out.set(productId, v.days > 0 ? v.used / v.days : 0);
  return out;
}

function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

module.exports = { usageSegments, usageReport, averageDailyUsage, bucketKey, weekKey, monthKey, round, toIso, DAY_MS };
