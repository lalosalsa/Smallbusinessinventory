'use strict';

const { db } = require('./db');
const { averageDailyUsage, round } = require('./usage');
const { toCsv } = require('./csv');

/**
 * Builds a suggested order sheet for one store + one supplier.
 *
 * mode:
 *   'par'   - top every item back up to its par level
 *   'usage' - order enough to cover `daysOfCover` days of measured usage
 *   'both'  - whichever of the two is larger (the default; safest for perishables)
 *
 * Quantities are suggested in the supplier's own pack (case, box, bag ...), rounded up,
 * because that is what the supplier actually ships.
 */
function suggestOrder({ storeId, supplierId, mode = 'both', daysOfCover = 7, lookbackDays = 28, onlyNeeded = true }) {
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
  if (!store) throw httpError(404, 'Store not found');
  if (!supplier) throw httpError(404, 'Supplier not found');

  const catalog = db.prepare(`
    SELECT p.id AS product_id, p.name AS product_name, p.category, p.base_unit,
           ps.sku, ps.pack_size, ps.pack_unit, ps.unit_cost, ps.is_primary,
           COALESCE(sp.on_hand, 0)       AS on_hand,
           COALESCE(sp.par_level, 0)     AS par_level,
           COALESCE(sp.reorder_point, 0) AS reorder_point
    FROM product_suppliers ps
    JOIN products p ON p.id = ps.product_id
    LEFT JOIN store_products sp ON sp.product_id = p.id AND sp.store_id = @storeId
    WHERE ps.supplier_id = @supplierId AND p.active = 1
    ORDER BY p.category, p.name
  `).all({ storeId, supplierId });

  const avgDaily = mode === 'par' ? new Map() : averageDailyUsage({ storeId, lookbackDays });

  const lines = catalog.map((row) => {
    const perDay = avgDaily.get(row.product_id) || 0;
    const usageTarget = perDay * daysOfCover;
    const parTarget = row.par_level;
    let target = parTarget;
    if (mode === 'usage') target = usageTarget;
    else if (mode === 'both') target = Math.max(parTarget, usageTarget);

    const needBase = Math.max(0, target - row.on_hand);
    const packSize = row.pack_size > 0 ? row.pack_size : 1;
    const qtyPacks = needBase > 0 ? Math.ceil(needBase / packSize) : 0;

    return {
      product_id: row.product_id,
      product_name: row.product_name,
      category: row.category || '',
      base_unit: row.base_unit,
      sku: row.sku,
      pack_size: packSize,
      pack_unit: row.pack_unit || 'case',
      unit_cost: row.unit_cost,
      on_hand: round(row.on_hand),
      par_level: round(parTarget),
      reorder_point: round(row.reorder_point),
      usage_per_day: round(perDay, 3),
      usage_target: round(usageTarget),
      need_base: round(needBase),
      qty_packs: qtyPacks,
      line_total: round(qtyPacks * row.unit_cost, 2),
      below_reorder: row.reorder_point > 0 && row.on_hand <= row.reorder_point,
    };
  });

  const visible = onlyNeeded ? lines.filter((l) => l.qty_packs > 0) : lines;
  const total = round(visible.reduce((s, l) => s + l.line_total, 0), 2);

  return {
    store,
    supplier,
    mode,
    days_of_cover: daysOfCover,
    lookback_days: lookbackDays,
    lines: visible,
    total,
    meets_minimum: total >= (supplier.min_order_value || 0),
    shortfall: round(Math.max(0, (supplier.min_order_value || 0) - total), 2),
  };
}

function createOrder({ storeId, supplierId, note = '', lines = [] }) {
  const insertOrder = db.prepare('INSERT INTO orders (store_id, supplier_id, note) VALUES (?, ?, ?)');
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, sku, pack_size, pack_unit, qty_packs, unit_cost)
    VALUES (@order_id, @product_id, @sku, @pack_size, @pack_unit, @qty_packs, @unit_cost)
    ON CONFLICT (order_id, product_id) DO UPDATE SET qty_packs = qty_packs + excluded.qty_packs
  `);

  return db.transaction(() => {
    const kept = lines.filter((l) => Number(l.qty_packs) > 0);
    if (!kept.length) throw httpError(400, 'An order needs at least one line with a quantity');
    const orderId = insertOrder.run(storeId, supplierId, note).lastInsertRowid;
    for (const line of kept) {
      const link = db.prepare('SELECT * FROM product_suppliers WHERE product_id = ? AND supplier_id = ?')
        .get(line.product_id, supplierId);
      insertItem.run({
        order_id: orderId,
        product_id: line.product_id,
        sku: line.sku || link?.sku || '',
        pack_size: Number(line.pack_size) || link?.pack_size || 1,
        pack_unit: line.pack_unit || link?.pack_unit || 'case',
        qty_packs: Number(line.qty_packs),
        unit_cost: line.unit_cost != null ? Number(line.unit_cost) : (link?.unit_cost || 0),
      });
    }
    return getOrder(orderId);
  })();
}

function getOrder(orderId) {
  const order = db.prepare(`
    SELECT o.*, s.name AS store_name, s.code AS store_code,
           v.name AS supplier_name, v.email AS supplier_email, v.phone AS supplier_phone,
           v.account_number, v.min_order_value
    FROM orders o
    JOIN stores s    ON s.id = o.store_id
    JOIN suppliers v ON v.id = o.supplier_id
    WHERE o.id = ?
  `).get(orderId);
  if (!order) return null;

  order.items = db.prepare(`
    SELECT oi.*, p.name AS product_name, p.category, p.base_unit,
           ROUND(oi.qty_packs * oi.unit_cost, 2) AS line_total
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
    ORDER BY p.category, p.name
  `).all(orderId);

  order.total = round(order.items.reduce((s, i) => s + i.qty_packs * i.unit_cost, 0), 2);
  order.unit_total = round(order.items.reduce((s, i) => s + i.qty_packs * i.pack_size, 0));
  return order;
}

/** Marks an order received and books the delivery into stock. */
function receiveOrder(orderId, { receivedAt = null, lines = null } = {}) {
  const order = getOrder(orderId);
  if (!order) throw httpError(404, 'Order not found');
  if (order.status === 'received') throw httpError(400, 'Order was already received');

  const when = receivedAt || new Date().toISOString().slice(0, 19).replace('T', ' ');
  const overrides = new Map((lines || []).map((l) => [Number(l.product_id), Number(l.qty_packs)]));

  const insertReceipt = db.prepare(`
    INSERT INTO receipts (store_id, product_id, qty, received_at, order_id, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const bumpStock = db.prepare(`
    INSERT INTO store_products (store_id, product_id, on_hand, updated_at)
    VALUES (@store_id, @product_id, @qty, datetime('now'))
    ON CONFLICT (store_id, product_id) DO UPDATE
      SET on_hand = ROUND(on_hand + excluded.on_hand, 4), updated_at = datetime('now')
  `);

  return db.transaction(() => {
    for (const item of order.items) {
      const packs = overrides.has(item.product_id) ? overrides.get(item.product_id) : item.qty_packs;
      const qty = packs * item.pack_size;
      if (!qty) continue;
      insertReceipt.run(order.store_id, item.product_id, qty, when, order.id, `Order #${order.id}`);
      bumpStock.run({ store_id: order.store_id, product_id: item.product_id, qty });
    }
    db.prepare("UPDATE orders SET status = 'received', received_at = ? WHERE id = ?").run(when, orderId);
    return getOrder(orderId);
  })();
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

/** The same supplier CSV, built straight from a suggested sheet before it is saved. */
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
  rows.push({
    sku: '', product_name: 'ORDER TOTAL', category: '', qty_packs: '', pack_unit: '',
    pack_size: '', base_unit: '', total_base_units: '', unit_cost: '', line_total: sheet.total,
  });
  const header = [
    `# Order sheet - ${sheet.supplier.name}`,
    `# Deliver to: ${sheet.store.name} (${sheet.store.code})`,
    `# Account: ${sheet.supplier.account_number || 'n/a'}   Prepared: ${new Date().toISOString().slice(0, 10)}`,
    sheet.meets_minimum ? null : `# Note: ${sheet.shortfall} under the ${sheet.supplier.min_order_value} minimum order`,
  ].filter(Boolean).join('\r\n');
  return `${header}\r\n${toCsv(ORDER_CSV_COLUMNS, rows)}`;
}

/** The CSV a supplier receives: their SKUs, their pack units, nothing internal. */
function orderToCsv(order) {
  const rows = order.items.map((i) => ({
    ...i,
    total_base_units: round(i.qty_packs * i.pack_size),
    line_total: round(i.qty_packs * i.unit_cost, 2),
  }));
  rows.push({
    sku: '', product_name: 'ORDER TOTAL', category: '', qty_packs: '', pack_unit: '',
    pack_size: '', base_unit: '', total_base_units: '', unit_cost: '', line_total: order.total,
  });
  const header = [
    `# Purchase order ${order.id} - ${order.supplier_name}`,
    `# Deliver to: ${order.store_name} (${order.store_code})`,
    `# Account: ${order.account_number || 'n/a'}   Raised: ${order.created_at}`,
    order.note ? `# Note: ${order.note.replace(/[\r\n]+/g, ' ')}` : null,
  ].filter(Boolean).join('\r\n');
  return `${header}\r\n${toCsv(ORDER_CSV_COLUMNS, rows)}`;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { suggestOrder, createOrder, getOrder, receiveOrder, orderToCsv, suggestionToCsv, httpError };
