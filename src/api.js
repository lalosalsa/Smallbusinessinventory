'use strict';

const express = require('express');
const { db } = require('./db');
const { usageReport, usageSegments, round } = require('./usage');
const { suggestOrder, createOrder, getOrder, receiveOrder, orderToCsv, suggestionToCsv, httpError } = require('./orders');
const { importProducts, importCounts, exportProductsCsv } = require('./importer');
const schedules = require('./schedules');
const { toCsv } = require('./csv');

const router = express.Router();

/* ------------------------------------------------------------------ stores */

router.get('/stores', (req, res) => {
  res.json(db.prepare('SELECT * FROM stores ORDER BY name').all());
});

router.post('/stores', (req, res) => {
  const { name, code, address = '' } = req.body || {};
  if (!name || !code) throw httpError(400, 'A store needs a name and a short code');
  const id = db.prepare('INSERT INTO stores (name, code, address) VALUES (?, ?, ?)').run(name.trim(), code.trim(), address).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM stores WHERE id = ?').get(id));
});

router.put('/stores/:id', (req, res) => {
  const { name, code, address = '', active = 1 } = req.body || {};
  db.prepare('UPDATE stores SET name = ?, code = ?, address = ?, active = ? WHERE id = ?')
    .run(name, code, address, active ? 1 : 0, req.params.id);
  res.json(db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.id));
});

router.delete('/stores/:id', (req, res) => {
  db.prepare('DELETE FROM stores WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* --------------------------------------------------------------- suppliers */

const SUPPLIER_FIELDS = ['name', 'contact_name', 'email', 'phone', 'account_number', 'order_days', 'lead_time_days', 'min_order_value', 'notes', 'active'];

router.get('/suppliers', (req, res) => {
  res.json(db.prepare(`
    SELECT v.*,
           (SELECT COUNT(*) FROM product_suppliers ps WHERE ps.supplier_id = v.id) AS product_count
    FROM suppliers v ORDER BY v.name
  `).all());
});

router.post('/suppliers', (req, res) => {
  const body = pick(req.body, SUPPLIER_FIELDS);
  if (!body.name) throw httpError(400, 'A supplier needs a name');
  const cols = Object.keys(body);
  const id = db.prepare(`INSERT INTO suppliers (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`)
    .run(body).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id));
});

router.put('/suppliers/:id', (req, res) => {
  const body = pick(req.body, SUPPLIER_FIELDS);
  const cols = Object.keys(body);
  if (cols.length) {
    db.prepare(`UPDATE suppliers SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
      .run({ ...body, id: Number(req.params.id) });
  }
  res.json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id));
});

router.delete('/suppliers/:id', (req, res) => {
  db.prepare('DELETE FROM suppliers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- products */

router.get('/products', (req, res) => {
  const { search = '', supplier_id = '', category = '' } = req.query;
  const rows = db.prepare(`
    SELECT p.*,
           (SELECT GROUP_CONCAT(v.name || ' (' || ps.sku || ')', ' | ')
              FROM product_suppliers ps JOIN suppliers v ON v.id = ps.supplier_id
             WHERE ps.product_id = p.id) AS supplier_summary
    FROM p_filtered p ORDER BY p.category, p.name
  `.replace('p_filtered', 'products')).all();

  let list = rows;
  if (search) {
    const q = String(search).toLowerCase();
    const skuMatches = new Set(db.prepare('SELECT product_id FROM product_suppliers WHERE sku LIKE ?').all(`%${search}%`).map((r) => r.product_id));
    list = list.filter((p) => p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q) || skuMatches.has(p.id));
  }
  if (category) list = list.filter((p) => (p.category || '') === category);
  if (supplier_id) {
    const ids = new Set(db.prepare('SELECT product_id FROM product_suppliers WHERE supplier_id = ?').all(supplier_id).map((r) => r.product_id));
    list = list.filter((p) => ids.has(p.id));
  }

  const links = db.prepare(`
    SELECT ps.*, v.name AS supplier_name FROM product_suppliers ps JOIN suppliers v ON v.id = ps.supplier_id
  `).all();
  const stock = db.prepare('SELECT * FROM store_products').all();

  for (const p of list) {
    p.suppliers = links.filter((l) => l.product_id === p.id);
    p.stock = stock.filter((s) => s.product_id === p.id);
  }
  res.json(list);
});

router.get('/categories', (req, res) => {
  res.json(db.prepare("SELECT DISTINCT category FROM products WHERE category <> '' ORDER BY category").all().map((r) => r.category));
});

router.post('/products', (req, res) => {
  const { name, category = '', base_unit = 'each', notes = '', suppliers = [], stock = [] } = req.body || {};
  if (!name) throw httpError(400, 'A product needs a name');
  const out = db.transaction(() => {
    const id = db.prepare('INSERT INTO products (name, category, base_unit, notes) VALUES (?, ?, ?, ?)')
      .run(name.trim(), category, base_unit, notes).lastInsertRowid;
    saveProductLinks(id, suppliers);
    saveProductStock(id, stock);
    return id;
  })();
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(out));
});

router.put('/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const { name, category = '', base_unit = 'each', notes = '', active = 1, suppliers, stock } = req.body || {};
  db.transaction(() => {
    db.prepare('UPDATE products SET name = ?, category = ?, base_unit = ?, notes = ?, active = ? WHERE id = ?')
      .run(name, category, base_unit, notes, active ? 1 : 0, id);
    if (Array.isArray(suppliers)) saveProductLinks(id, suppliers, true);
    if (Array.isArray(stock)) saveProductStock(id, stock);
  })();
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

router.delete('/products/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

function saveProductLinks(productId, links, replace = false) {
  if (replace) {
    const keep = links.filter((l) => l.id).map((l) => l.id);
    const placeholders = keep.length ? keep.map(() => '?').join(',') : null;
    db.prepare(`DELETE FROM product_suppliers WHERE product_id = ?${placeholders ? ` AND id NOT IN (${placeholders})` : ''}`)
      .run(productId, ...keep);
  }
  for (const l of links) {
    if (!l.supplier_id || !l.sku) continue;
    const payload = {
      product_id: productId,
      supplier_id: Number(l.supplier_id),
      sku: String(l.sku).trim(),
      pack_size: Number(l.pack_size) || 1,
      pack_unit: l.pack_unit || 'case',
      unit_cost: Number(l.unit_cost) || 0,
      is_primary: l.is_primary ? 1 : 0,
    };
    const existing = db.prepare('SELECT id FROM product_suppliers WHERE product_id = ? AND supplier_id = ?')
      .get(productId, payload.supplier_id);
    if (existing) {
      db.prepare(`UPDATE product_suppliers SET sku = @sku, pack_size = @pack_size, pack_unit = @pack_unit,
                  unit_cost = @unit_cost, is_primary = @is_primary WHERE id = @id`).run({ ...payload, id: existing.id });
    } else {
      db.prepare(`INSERT INTO product_suppliers (product_id, supplier_id, sku, pack_size, pack_unit, unit_cost, is_primary)
                  VALUES (@product_id, @supplier_id, @sku, @pack_size, @pack_unit, @unit_cost, @is_primary)`).run(payload);
    }
  }
}

function saveProductStock(productId, stock) {
  for (const s of stock || []) {
    if (!s.store_id) continue;
    db.prepare(`
      INSERT INTO store_products (store_id, product_id, par_level, reorder_point, on_hand, updated_at)
      VALUES (@store_id, @product_id, @par_level, @reorder_point, @on_hand, datetime('now'))
      ON CONFLICT (store_id, product_id) DO UPDATE SET
        par_level = excluded.par_level, reorder_point = excluded.reorder_point,
        on_hand = excluded.on_hand, updated_at = datetime('now')
    `).run({
      store_id: Number(s.store_id),
      product_id: productId,
      par_level: Number(s.par_level) || 0,
      reorder_point: Number(s.reorder_point) || 0,
      on_hand: Number(s.on_hand) || 0,
    });
  }
}

/* --------------------------------------------------------------- inventory */

router.get('/inventory', (req, res) => {
  const storeId = Number(req.query.store_id);
  if (!storeId) throw httpError(400, 'store_id is required');
  const { search = '', supplier_id = '', category = '', only = '' } = req.query;

  let rows = db.prepare(`
    SELECT p.id AS product_id, p.name AS product_name, p.category, p.base_unit,
           COALESCE(sp.on_hand, 0) AS on_hand,
           COALESCE(sp.par_level, 0) AS par_level,
           COALESCE(sp.reorder_point, 0) AS reorder_point,
           sp.updated_at,
           ps.supplier_id, v.name AS supplier_name, ps.sku, ps.pack_size, ps.pack_unit, ps.unit_cost,
           (SELECT MAX(counted_at) FROM counts c WHERE c.store_id = @storeId AND c.product_id = p.id) AS last_counted
    FROM products p
    LEFT JOIN store_products sp ON sp.product_id = p.id AND sp.store_id = @storeId
    LEFT JOIN product_suppliers ps ON ps.product_id = p.id AND ps.is_primary = 1
    LEFT JOIN suppliers v ON v.id = ps.supplier_id
    WHERE p.active = 1
    ORDER BY p.category, p.name
  `).all({ storeId });

  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter((r) => r.product_name.toLowerCase().includes(q)
      || (r.sku || '').toLowerCase().includes(q)
      || (r.category || '').toLowerCase().includes(q));
  }
  if (category) rows = rows.filter((r) => (r.category || '') === category);
  if (supplier_id) rows = rows.filter((r) => String(r.supplier_id) === String(supplier_id));
  if (only === 'below_par') rows = rows.filter((r) => r.par_level > 0 && r.on_hand < r.par_level);
  if (only === 'below_reorder') rows = rows.filter((r) => r.reorder_point > 0 && r.on_hand <= r.reorder_point);

  res.json(rows.map((r) => ({ ...r, needed: round(Math.max(0, r.par_level - r.on_hand)) })));
});

/** Saves a counting session: writes count history and resets on-hand for each item. */
router.post('/counts', (req, res) => {
  const { store_id, counted_at = null, note = '', lines = [] } = req.body || {};
  if (!store_id) throw httpError(400, 'store_id is required');
  const clean = lines.filter((l) => l.qty !== '' && l.qty != null && !Number.isNaN(Number(l.qty)));
  if (!clean.length) throw httpError(400, 'No counted quantities were submitted');

  const when = counted_at ? `${counted_at}`.replace('T', ' ').slice(0, 19) : new Date().toISOString().slice(0, 19).replace('T', ' ');
  const stamp = when.length === 10 ? `${when} 12:00:00` : when;

  const insertCount = db.prepare('INSERT INTO counts (store_id, product_id, qty, counted_at, note) VALUES (?, ?, ?, ?, ?)');
  const setStock = db.prepare(`
    INSERT INTO store_products (store_id, product_id, on_hand, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (store_id, product_id) DO UPDATE SET on_hand = excluded.on_hand, updated_at = datetime('now')
  `);

  db.transaction(() => {
    for (const l of clean) {
      insertCount.run(store_id, l.product_id, Number(l.qty), stamp, note);
      setStock.run(store_id, l.product_id, Number(l.qty));
    }
  })();

  res.status(201).json({ saved: clean.length, counted_at: stamp });
});

router.get('/counts', (req, res) => {
  const { store_id = '', product_id = '', limit = 200 } = req.query;
  let sql = `
    SELECT c.*, p.name AS product_name, s.name AS store_name
    FROM counts c JOIN products p ON p.id = c.product_id JOIN stores s ON s.id = c.store_id WHERE 1=1
  `;
  const params = {};
  if (store_id) { sql += ' AND c.store_id = @store_id'; params.store_id = Number(store_id); }
  if (product_id) { sql += ' AND c.product_id = @product_id'; params.product_id = Number(product_id); }
  sql += ' ORDER BY c.counted_at DESC, c.id DESC LIMIT @limit';
  params.limit = Number(limit);
  res.json(db.prepare(sql).all(params));
});

/** Stock arriving outside an order: a walk-in buy, a transfer, a credit. */
router.post('/receipts', (req, res) => {
  const { store_id, product_id, qty, received_at = null, note = '' } = req.body || {};
  if (!store_id || !product_id || qty == null) throw httpError(400, 'store_id, product_id and qty are required');
  const when = received_at ? `${received_at}`.replace('T', ' ').slice(0, 19) : new Date().toISOString().slice(0, 19).replace('T', ' ');
  const stamp = when.length === 10 ? `${when} 12:00:00` : when;
  db.transaction(() => {
    db.prepare('INSERT INTO receipts (store_id, product_id, qty, received_at, note) VALUES (?, ?, ?, ?, ?)')
      .run(store_id, product_id, Number(qty), stamp, note);
    db.prepare(`
      INSERT INTO store_products (store_id, product_id, on_hand, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (store_id, product_id) DO UPDATE SET on_hand = ROUND(on_hand + excluded.on_hand, 4), updated_at = datetime('now')
    `).run(store_id, product_id, Number(qty));
  })();
  res.status(201).json({ ok: true });
});

/* ------------------------------------------------------------------- usage */

router.get('/usage', (req, res) => {
  const { from, to, store_id = '', product_id = '', group_by = 'total', category = '' } = req.query;
  if (!from || !to) throw httpError(400, 'from and to dates are required');
  res.json(usageReport({
    from, to,
    storeId: store_id || null,
    productId: product_id || null,
    groupBy: group_by,
    category: category || null,
  }));
});

router.get('/usage/export.csv', (req, res) => {
  const { from, to, store_id = '', group_by = 'total', category = '' } = req.query;
  if (!from || !to) throw httpError(400, 'from and to dates are required');
  const report = usageReport({ from, to, storeId: store_id || null, groupBy: group_by, category: category || null });

  const columns = [
    { key: 'store_name', label: 'Store' },
    { key: 'product_name', label: 'Product' },
    { key: 'category', label: 'Category' },
    { key: 'base_unit', label: 'Unit' },
    { key: 'used', label: `Used ${from} to ${to}` },
    { key: 'per_week', label: 'Avg per week' },
    { key: 'per_month', label: 'Avg per month' },
    { key: 'est_cost', label: 'Est. cost' },
    ...report.buckets.filter((b) => b !== 'total').map((b) => ({ key: `bucket_${b}`, label: b })),
  ];
  const rows = report.rows.map((r) => {
    const flat = { ...r };
    for (const b of report.buckets) flat[`bucket_${b}`] = r.buckets[b] ?? 0;
    return flat;
  });
  sendCsv(res, `usage-${from}_to_${to}.csv`, toCsv(columns, rows));
});

router.get('/usage/segments', (req, res) => {
  const { from, to, store_id = '', product_id = '' } = req.query;
  if (!from || !to) throw httpError(400, 'from and to dates are required');
  res.json(usageSegments({ from, to, storeId: store_id || null, productId: product_id || null }));
});

/* ------------------------------------------------------------------ orders */

router.post('/orders/suggest', (req, res) => {
  const { store_id, supplier_id, mode = 'both', days_of_cover = 7, lookback_days = 28, only_needed = true } = req.body || {};
  if (!store_id || !supplier_id) throw httpError(400, 'store_id and supplier_id are required');
  res.json(suggestOrder({
    storeId: Number(store_id),
    supplierId: Number(supplier_id),
    mode,
    daysOfCover: Number(days_of_cover) || 7,
    lookbackDays: Number(lookback_days) || 28,
    onlyNeeded: only_needed !== false,
  }));
});

/** A supplier's order sheet as CSV without saving an order first. */
router.get('/orders/sheet.csv', (req, res) => {
  const { store_id, supplier_id, mode = 'both', days_of_cover = 7, lookback_days = 28 } = req.query;
  if (!store_id || !supplier_id) throw httpError(400, 'store_id and supplier_id are required');
  const sheet = suggestOrder({
    storeId: Number(store_id),
    supplierId: Number(supplier_id),
    mode,
    daysOfCover: Number(days_of_cover) || 7,
    lookbackDays: Number(lookback_days) || 28,
    onlyNeeded: true,
  });
  const name = `order-sheet-${slug(sheet.supplier.name)}-${slug(sheet.store.code)}.csv`;
  sendCsv(res, name, suggestionToCsv(sheet));
});

router.get('/orders', (req, res) => {
  const { status = '', store_id = '' } = req.query;
  let sql = `
    SELECT o.*, s.name AS store_name, v.name AS supplier_name,
           (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS line_count,
           (SELECT ROUND(SUM(oi.qty_packs * oi.unit_cost), 2) FROM order_items oi WHERE oi.order_id = o.id) AS total
    FROM orders o JOIN stores s ON s.id = o.store_id JOIN suppliers v ON v.id = o.supplier_id WHERE 1=1
  `;
  const params = {};
  if (status) { sql += ' AND o.status = @status'; params.status = status; }
  if (store_id) { sql += ' AND o.store_id = @store_id'; params.store_id = Number(store_id); }
  sql += ' ORDER BY o.created_at DESC, o.id DESC';
  res.json(db.prepare(sql).all(params));
});

router.post('/orders', (req, res) => {
  const { store_id, supplier_id, note = '', lines = [] } = req.body || {};
  if (!store_id || !supplier_id) throw httpError(400, 'store_id and supplier_id are required');
  res.status(201).json(createOrder({ storeId: Number(store_id), supplierId: Number(supplier_id), note, lines }));
});

router.get('/orders/:id', (req, res) => {
  const order = getOrder(Number(req.params.id));
  if (!order) throw httpError(404, 'Order not found');
  res.json(order);
});

router.put('/orders/:id', (req, res) => {
  const id = Number(req.params.id);
  const order = getOrder(id);
  if (!order) throw httpError(404, 'Order not found');
  const { note, lines } = req.body || {};

  db.transaction(() => {
    if (note !== undefined) db.prepare('UPDATE orders SET note = ? WHERE id = ?').run(note, id);
    if (Array.isArray(lines)) {
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      const insert = db.prepare(`
        INSERT INTO order_items (order_id, product_id, sku, pack_size, pack_unit, qty_packs, unit_cost)
        VALUES (@order_id, @product_id, @sku, @pack_size, @pack_unit, @qty_packs, @unit_cost)
      `);
      for (const l of lines) {
        if (!(Number(l.qty_packs) > 0)) continue;
        insert.run({
          order_id: id,
          product_id: Number(l.product_id),
          sku: l.sku || '',
          pack_size: Number(l.pack_size) || 1,
          pack_unit: l.pack_unit || 'case',
          qty_packs: Number(l.qty_packs),
          unit_cost: Number(l.unit_cost) || 0,
        });
      }
    }
  })();
  res.json(getOrder(id));
});

router.post('/orders/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!['draft', 'sent', 'received', 'cancelled'].includes(status)) throw httpError(400, 'Unknown status');
  const id = Number(req.params.id);
  if (status === 'received') return res.json(receiveOrder(id));
  db.prepare("UPDATE orders SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END WHERE id = ?")
    .run(status, status, id);
  res.json(getOrder(id));
});

router.post('/orders/:id/receive', (req, res) => {
  const { received_at = null, lines = null } = req.body || {};
  res.json(receiveOrder(Number(req.params.id), { receivedAt: received_at, lines }));
});

router.delete('/orders/:id', (req, res) => {
  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/orders/:id/export.csv', (req, res) => {
  const order = getOrder(Number(req.params.id));
  if (!order) throw httpError(404, 'Order not found');
  const name = `order-${order.id}-${slug(order.supplier_name)}-${slug(order.store_code)}.csv`;
  sendCsv(res, name, orderToCsv(order));
});

/* --------------------------------------------------------------- schedules */

router.get('/schedules', (req, res) => {
  res.json(schedules.listSchedules({
    activeOnly: req.query.active === '1',
    storeId: req.query.store_id || null,
  }));
});

router.get('/schedules/upcoming', (req, res) => {
  res.json(schedules.upcoming(Number(req.query.days) || 30));
});

/** Raises drafts for every schedule that is due — the "catch me up" button. */
router.post('/schedules/run-due', (req, res) => {
  res.json({ runs: schedules.runDueSchedules() });
});

router.post('/schedules', (req, res) => {
  res.status(201).json(schedules.saveSchedule(req.body || {}));
});

router.get('/schedules/:id', (req, res) => {
  const schedule = schedules.getSchedule(Number(req.params.id));
  if (!schedule) throw httpError(404, 'Schedule not found');
  res.json(schedule);
});

router.put('/schedules/:id', (req, res) => {
  res.json(schedules.saveSchedule(req.body || {}, Number(req.params.id)));
});

router.delete('/schedules/:id', (req, res) => {
  db.prepare('DELETE FROM order_schedules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/** Build the draft this schedule is due for (force = run it early). */
router.post('/schedules/:id/run', (req, res) => {
  const { force = false, skip = false } = req.body || {};
  res.json(schedules.runSchedule(Number(req.params.id), { force, markOnly: skip }));
});

/* --------------------------------------------------------- import / export */

router.post('/import/products', (req, res) => {
  const { csv, default_store_id = null } = req.body || {};
  if (!csv) throw httpError(400, 'No CSV content received');
  res.json(importProducts(csv, { defaultStoreId: default_store_id ? Number(default_store_id) : null }));
});

router.post('/import/counts', (req, res) => {
  const { csv, default_store_id = null, counted_at = null } = req.body || {};
  if (!csv) throw httpError(400, 'No CSV content received');
  res.json(importCounts(csv, { defaultStoreId: default_store_id ? Number(default_store_id) : null, countedAt: counted_at }));
});

router.get('/export/products.csv', (req, res) => {
  sendCsv(res, 'products.csv', exportProductsCsv({ storeId: req.query.store_id || null }));
});

router.get('/export/inventory.csv', (req, res) => {
  const storeId = Number(req.query.store_id);
  if (!storeId) throw httpError(400, 'store_id is required');
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  const rows = db.prepare(`
    SELECT p.name AS product_name, p.category, p.base_unit,
           COALESCE(v.name, '') AS supplier_name, COALESCE(ps.sku, '') AS sku,
           COALESCE(sp.on_hand, 0) AS on_hand, COALESCE(sp.par_level, 0) AS par_level,
           COALESCE(sp.reorder_point, 0) AS reorder_point,
           MAX(0, COALESCE(sp.par_level, 0) - COALESCE(sp.on_hand, 0)) AS needed,
           (SELECT MAX(counted_at) FROM counts c WHERE c.store_id = @storeId AND c.product_id = p.id) AS last_counted
    FROM products p
    LEFT JOIN store_products sp ON sp.product_id = p.id AND sp.store_id = @storeId
    LEFT JOIN product_suppliers ps ON ps.product_id = p.id AND ps.is_primary = 1
    LEFT JOIN suppliers v ON v.id = ps.supplier_id
    WHERE p.active = 1 ORDER BY p.category, p.name
  `).all({ storeId });
  const columns = ['product_name', 'category', 'base_unit', 'supplier_name', 'sku', 'on_hand', 'par_level', 'reorder_point', 'needed', 'last_counted'];
  sendCsv(res, `inventory-${slug(store?.code || 'store')}.csv`, toCsv(columns, rows));
});

/** A blank counting sheet to print or fill in on a tablet, then import back. */
router.get('/export/count-sheet.csv', (req, res) => {
  const storeId = Number(req.query.store_id);
  if (!storeId) throw httpError(400, 'store_id is required');
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  const rows = db.prepare(`
    SELECT s.code AS store_code, p.name AS product_name, COALESCE(ps.sku, '') AS sku,
           p.category, p.base_unit, '' AS qty, COALESCE(sp.on_hand, 0) AS last_on_hand
    FROM products p
    CROSS JOIN stores s
    LEFT JOIN store_products sp ON sp.product_id = p.id AND sp.store_id = s.id
    LEFT JOIN product_suppliers ps ON ps.product_id = p.id AND ps.is_primary = 1
    WHERE p.active = 1 AND s.id = @storeId ORDER BY p.category, p.name
  `).all({ storeId });
  const columns = ['store_code', 'product_name', 'sku', 'category', 'base_unit', 'qty', 'last_on_hand'];
  sendCsv(res, `count-sheet-${slug(store?.code || 'store')}.csv`, toCsv(columns, rows));
});

/* --------------------------------------------------------------- dashboard */

router.get('/dashboard', (req, res) => {
  const stores = db.prepare('SELECT * FROM stores WHERE active = 1 ORDER BY name').all();
  const summary = stores.map((store) => {
    const stats = db.prepare(`
      SELECT COUNT(*) AS tracked,
             SUM(CASE WHEN par_level > 0 AND on_hand < par_level THEN 1 ELSE 0 END) AS below_par,
             SUM(CASE WHEN reorder_point > 0 AND on_hand <= reorder_point THEN 1 ELSE 0 END) AS below_reorder,
             MAX(updated_at) AS last_update
      FROM store_products WHERE store_id = ?
    `).get(store.id);
    const value = db.prepare(`
      SELECT ROUND(SUM(sp.on_hand * (ps.unit_cost / NULLIF(ps.pack_size, 0))), 2) AS stock_value
      FROM store_products sp JOIN product_suppliers ps ON ps.product_id = sp.product_id AND ps.is_primary = 1
      WHERE sp.store_id = ?
    `).get(store.id);
    const lastCount = db.prepare('SELECT MAX(counted_at) AS at FROM counts WHERE store_id = ?').get(store.id);
    return { ...store, ...stats, stock_value: value.stock_value || 0, last_count: lastCount.at };
  });

  const openOrders = db.prepare(`
    SELECT o.id, o.status, o.created_at, s.name AS store_name, v.name AS supplier_name,
           (SELECT ROUND(SUM(oi.qty_packs * oi.unit_cost), 2) FROM order_items oi WHERE oi.order_id = o.id) AS total
    FROM orders o JOIN stores s ON s.id = o.store_id JOIN suppliers v ON v.id = o.supplier_id
    WHERE o.status IN ('draft', 'sent') ORDER BY o.created_at DESC LIMIT 20
  `).all();

  const counts = db.prepare(`
    SELECT (SELECT COUNT(*) FROM products WHERE active = 1) AS products,
           (SELECT COUNT(*) FROM suppliers WHERE active = 1) AS suppliers,
           (SELECT COUNT(*) FROM product_suppliers) AS skus
  `).get();

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 27 * 86400000).toISOString().slice(0, 10);
  const topUsage = usageReport({ from, to, groupBy: 'total' }).rows.slice(0, 10);

  const upcomingOrders = schedules.upcoming(14);
  const dueNow = upcomingOrders.filter((u) => u.is_due);

  res.json({
    stores: summary,
    open_orders: openOrders,
    counts,
    top_usage: topUsage,
    usage_window: { from, to },
    schedule_due: dueNow,
    schedule_upcoming: upcomingOrders.filter((u) => !u.is_due).slice(0, 8),
  });
});

/* ----------------------------------------------------------------- helpers */

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f];
  return out;
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
}

function sendCsv(res, filename, body) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

module.exports = router;
