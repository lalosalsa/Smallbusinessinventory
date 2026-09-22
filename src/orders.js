'use strict';

const { db, tx } = require('./db');
const { averageDailyUsage, round } = require('./usage');
const { toCsv } = require('./csv');

/**
 * Builds a suggested order sheet for one supplier at one location.
 *
 * mode:
 *   'par'   - top every item back up to its par level
 *   'usage' - order enough to cover `daysOfCover` days of measured usage
 *   'both'  - whichever of the two is larger (the default; safest for perishables)
 *
 * Quantities are suggested in the supplier's own pack (case, box, bag ...), rounded up,
 * because that is what the supplier actually ships.
 */
async function suggestOrder({ accountId, storeId, supplierId, mode = 'both', daysOfCover = 7, lookbackDays = 28, onlyNeeded = true }) {
  const store = await db.one('SELECT * FROM stores WHERE id = :id AND account_id = :account', { id: storeId, account: accountId });
  const supplier = await db.one('SELECT * FROM suppliers WHERE id = :id AND account_id = :account', { id: supplierId, account: accountId });
  if (!store) throw httpError(404, 'Location not found');
  if (!supplier) throw httpError(404, 'Supplier not found');

  const catalog = await db.all(`
    SELECT p.id AS product_id, p.name AS product_name, p.category, p.base_unit,
           ps.sku, ps.pack_size, ps.pack_unit, ps.unit_cost, ps.is_primary,
           COALESCE(sp.on_hand, 0)       AS on_hand,
           COALESCE(sp.par_level, 0)     AS par_level,
           COALESCE(sp.reorder_point, 0) AS reorder_point
    FROM product_suppliers ps
    JOIN products p ON p.id = ps.product_id
    LEFT JOIN store_products sp ON sp.product_id = p.id AND sp.store_id = :storeId
    WHERE ps.supplier_id = :supplierId AND ps.account_id = :account AND p.active
    ORDER BY p.category, p.name
  `, { storeId, supplierId, account: accountId });

  const avgDaily = mode === 'par' ? new Map() : await averageDailyUsage({ accountId, storeId, lookbackDays });

  const lines = catalog.map((row) => {
    const perDay = avgDaily.get(row.product_id) || 0;
    const usageTarget = perDay * daysOfCover;
    const parTarget = Number(row.par_level);
    let target = parTarget;
    if (mode === 'usage') target = usageTarget;
    else if (mode === 'both') target = Math.max(parTarget, usageTarget);

    const onHand = Number(row.on_hand);
    const needBase = Math.max(0, target - onHand);
    const packSize = Number(row.pack_size) > 0 ? Number(row.pack_size) : 1;
    const qtyPacks = needBase > 0 ? Math.ceil(needBase / packSize) : 0;
    const unitCost = Number(row.unit_cost);

    return {
      product_id: row.product_id,
      product_name: row.product_name,
      category: row.category || '',
      base_unit: row.base_unit,
      sku: row.sku,
      pack_size: packSize,
      pack_unit: row.pack_unit || 'case',
      unit_cost: unitCost,
      on_hand: round(onHand),
      par_level: round(parTarget),
      reorder_point: round(row.reorder_point),
      usage_per_day: round(perDay, 3),
      usage_target: round(usageTarget),
      need_base: round(needBase),
      qty_packs: qtyPacks,
      line_total: round(qtyPacks * unitCost, 2),
      below_reorder: Number(row.reorder_point) > 0 && onHand <= Number(row.reorder_point),
    };
  });

  const visible = onlyNeeded ? lines.filter((l) => l.qty_packs > 0) : lines;
  const total = round(visible.reduce((s, l) => s + l.line_total, 0), 2);
  const minimum = Number(supplier.min_order_value) || 0;

  return {
    store,
    supplier,
    mode,
    days_of_cover: daysOfCover,
    lookback_days: lookbackDays,
    lines: visible,
    total,
    meets_minimum: total >= minimum,
    shortfall: round(Math.max(0, minimum - total), 2),
  };
}

async function createOrder({ accountId, storeId, supplierId, note = '', lines = [], createdBy = null, scheduleId = null }) {
  const kept = lines.filter((l) => Number(l.qty_packs) > 0);
  if (!kept.length) throw httpError(400, 'An order needs at least one line with a quantity');

  const orderId = await tx(async (t) => {
    const order = await t.one(`
      INSERT INTO orders (account_id, store_id, supplier_id, note, created_by, schedule_id)
      VALUES (:account, :store, :supplier, :note, :by, :schedule) RETURNING id
    `, { account: accountId, store: storeId, supplier: supplierId, note, by: createdBy, schedule: scheduleId });

    for (const line of kept) {
      const link = await t.one(`
        SELECT * FROM product_suppliers WHERE product_id = :product AND supplier_id = :supplier AND account_id = :account
      `, { product: line.product_id, supplier: supplierId, account: accountId });

      await t.run(`
        INSERT INTO order_items (order_id, product_id, sku, pack_size, pack_unit, qty_packs, unit_cost)
        VALUES (:order, :product, :sku, :packSize, :packUnit, :qty, :cost)
        ON CONFLICT (order_id, product_id) DO UPDATE SET qty_packs = order_items.qty_packs + excluded.qty_packs
      `, {
        order: order.id,
        product: line.product_id,
        sku: line.sku || link?.sku || '',
        packSize: Number(line.pack_size) || Number(link?.pack_size) || 1,
        packUnit: line.pack_unit || link?.pack_unit || 'case',
        qty: Number(line.qty_packs),
        cost: line.unit_cost != null ? Number(line.unit_cost) : Number(link?.unit_cost || 0),
      });
    }
    return order.id;
  });

  return getOrder(accountId, orderId);
}

async function getOrder(accountId, orderId) {
  const order = await db.one(`
    SELECT o.*, s.name AS store_name, s.code AS store_code,
           v.name AS supplier_name, v.email AS supplier_email, v.phone AS supplier_phone,
           v.account_number, v.min_order_value,
           (SELECT email FROM members WHERE id = o.created_by) AS created_by_email
    FROM orders o
    JOIN stores s    ON s.id = o.store_id
    JOIN suppliers v ON v.id = o.supplier_id
    WHERE o.id = :id AND o.account_id = :account
  `, { id: orderId, account: accountId });
  if (!order) return null;

  order.items = await db.all(`
    SELECT oi.*, p.name AS product_name, p.category, p.base_unit,
           round(oi.qty_packs * oi.unit_cost, 2) AS line_total
    FROM order_items oi JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = :id ORDER BY p.category, p.name
  `, { id: orderId });

  order.total = round(order.items.reduce((s, i) => s + i.qty_packs * i.unit_cost, 0), 2);
  order.unit_total = round(order.items.reduce((s, i) => s + i.qty_packs * i.pack_size, 0));
  return order;
}

/** Marks an order received and books the delivery into stock. */
async function receiveOrder(accountId, orderId, { receivedAt = null, lines = null } = {}) {
  const order = await getOrder(accountId, orderId);
  if (!order) throw httpError(404, 'Order not found');
  if (order.status === 'received') throw httpError(400, 'Order was already received');

  const when = receivedAt ? stampFor(receivedAt) : new Date().toISOString();
  const overrides = new Map((lines || []).map((l) => [Number(l.product_id), Number(l.qty_packs)]));

  await tx(async (t) => {
    for (const item of order.items) {
      const packs = overrides.has(item.product_id) ? overrides.get(item.product_id) : Number(item.qty_packs);
      const qty = packs * Number(item.pack_size);
      if (!qty) continue;

      await t.run(`
        INSERT INTO receipts (account_id, store_id, product_id, qty, received_at, order_id, note)
        VALUES (:account, :store, :product, :qty, :at, :order, :note)
      `, { account: accountId, store: order.store_id, product: item.product_id, qty, at: when, order: order.id, note: `Order #${order.id}` });

      await t.run(`
        INSERT INTO store_products (account_id, store_id, product_id, on_hand, updated_at)
        VALUES (:account, :store, :product, :qty, now())
        ON CONFLICT (store_id, product_id) DO UPDATE
          SET on_hand = round(store_products.on_hand + excluded.on_hand, 4), updated_at = now()
      `, { account: accountId, store: order.store_id, product: item.product_id, qty });
    }
    await t.run(`UPDATE orders SET status = 'received', received_at = :at WHERE id = :id`, { at: when, id: orderId });
  });

  return getOrder(accountId, orderId);
}

/** A bare date means midday UTC, so a count or delivery never lands on the wrong day. */
function stampFor(value) {
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T12:00:00.000Z`;
  const parsed = new Date(s.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

const ORDER_CSV_COLUMNS = [
  { key: 'sku', label: 'Supplier SKU' },
  { key: 'product_name', label: 'Product' },
  { key: 'category', label: 'Category' },
  { key: 'qty_packs', label: 'Qty' },
  { key: 'pack_unit', label: 'Unit' },
  { key: 'pack_size', label: 'Pack Size' },
  { key: 'base_unit', label: 'Base Unit' },
  { key: 'total_base_units', label: 'Total Units' },
  { key: 'unit_cost', label: 'Price' },
  { key: 'line_total', label: 'Line Total' },
];

function totalRow(total) {
  return {
    sku: '', product_name: 'ORDER TOTAL', category: '', qty_packs: '', pack_unit: '',
    pack_size: '', base_unit: '', total_base_units: '', unit_cost: '', line_total: total,
  };
}

/** The CSV a supplier receives: their SKUs, their pack units, nothing internal. */
function orderToCsv(order) {
  const rows = order.items.map((i) => ({
    ...i,
    total_base_units: round(i.qty_packs * i.pack_size),
    line_total: round(i.qty_packs * i.unit_cost, 2),
  }));
  rows.push(totalRow(order.total));

  const header = [
    `# Purchase order ${order.id} - ${order.supplier_name}`,
    `# Deliver to: ${order.store_name} (${order.store_code})`,
    `# Account: ${order.account_number || 'n/a'}   Raised: ${String(order.created_at).slice(0, 10)}`,
    order.note ? `# Note: ${order.note.replace(/[\r\n]+/g, ' ')}` : null,
  ].filter(Boolean).join('\r\n');

  return `${header}\r\n${toCsv(ORDER_CSV_COLUMNS, rows)}`;
}

/** The same supplier CSV, built from a suggested sheet before it is saved. */
function suggestionToCsv(sheet) {
  const rows = sheet.lines.map((l) => ({
    sku: l.sku,
    product_name: l.product_name,
    category: l.category,
    qty_packs: l.qty_packs,
    pack_unit: l.pack_unit,
    pack_size: l.pack_size,
    base_unit: l.base_unit,
    total_base_units: round(l.qty_packs * l.pack_size),
    unit_cost: l.unit_cost,
    line_total: l.line_total,
  }));
  rows.push(totalRow(sheet.total));

  const header = [
    `# Order sheet - ${sheet.supplier.name}`,
    `# Deliver to: ${sheet.store.name} (${sheet.store.code})`,
    `# Account: ${sheet.supplier.account_number || 'n/a'}   Prepared: ${new Date().toISOString().slice(0, 10)}`,
    sheet.meets_minimum ? null : `# Note: ${sheet.shortfall} under the ${sheet.supplier.min_order_value} minimum order`,
  ].filter(Boolean).join('\r\n');

  return `${header}\r\n${toCsv(ORDER_CSV_COLUMNS, rows)}`;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { suggestOrder, createOrder, getOrder, receiveOrder, orderToCsv, suggestionToCsv, stampFor, httpError };
