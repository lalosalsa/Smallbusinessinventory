'use strict';

const { db } = require('./db');
const { parseCsvObjects, toCsv, num, bool } = require('./csv');
const { httpError } = require('./orders');

/**
 * Column aliases so a supplier's own spreadsheet usually imports as-is:
 * canonical name -> the header spellings we accept for it.
 */
const PRODUCT_ALIASES = {
  product_name: ['product', 'item', 'item_name', 'description', 'product_description', 'name'],
  category: ['cat', 'group', 'department', 'type'],
  base_unit: ['unit', 'uom', 'base_uom', 'stock_unit', 'count_unit'],
  supplier_name: ['supplier', 'vendor', 'vendor_name', 'distributor'],
  sku: ['supplier_sku', 'item_code', 'item_number', 'product_code', 'vendor_sku', 'code', 'part_number'],
  pack_size: ['case_size', 'pack', 'pack_qty', 'units_per_case', 'qty_per_case', 'size'],
  pack_unit: ['case_unit', 'order_unit', 'purchase_unit', 'pack_uom'],
  unit_cost: ['cost', 'price', 'case_price', 'unit_price', 'case_cost'],
  store_code: ['store', 'store_name', 'location', 'site'],
  par_level: ['par', 'target', 'target_level', 'par_qty'],
  reorder_point: ['reorder', 'min', 'min_level', 'reorder_level'],
  on_hand: ['qty', 'quantity', 'stock', 'current_qty', 'count', 'on_hand_qty'],
  notes: ['note', 'comment', 'comments'],
  active: ['is_active', 'enabled'],
};

const COUNT_ALIASES = {
  store_code: ['store', 'store_name', 'location', 'site'],
  product_name: ['product', 'item', 'item_name', 'description', 'name'],
  sku: ['supplier_sku', 'item_code', 'product_code', 'code'],
  qty: ['quantity', 'count', 'on_hand', 'counted', 'amount'],
  counted_at: ['date', 'count_date', 'counted_on', 'timestamp'],
  note: ['notes', 'comment'],
};

function resolveStore(token) {
  if (!token) return null;
  const t = String(token).trim();
  return db.prepare('SELECT * FROM stores WHERE code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE').get(t, t);
}

function upsertSupplier(name) {
  const clean = String(name).trim();
  const found = db.prepare('SELECT * FROM suppliers WHERE name = ? COLLATE NOCASE').get(clean);
  if (found) return found;
  const id = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(clean).lastInsertRowid;
  return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
}

/**
 * Imports the product list: products, their supplier + SKU, pack sizes and costs,
 * and per-store par levels / current stock when those columns are present.
 * Re-importing the same file updates in place rather than duplicating.
 */
function importProducts(csvText, { defaultStoreId = null } = {}) {
  const { rows, unknown } = parseCsvObjects(csvText, PRODUCT_ALIASES);
  if (!rows.length) throw httpError(400, 'That CSV has no data rows');

  const result = {
    rows: rows.length,
    products_created: 0, products_updated: 0,
    suppliers_created: 0, links_created: 0, links_updated: 0,
    store_rows: 0, errors: [], unknown_columns: unknown,
  };

  const findProduct = db.prepare('SELECT * FROM products WHERE name = ? COLLATE NOCASE');
  const insertProduct = db.prepare('INSERT INTO products (name, category, base_unit, notes, active) VALUES (?, ?, ?, ?, ?)');
  const updateProduct = db.prepare(`
    UPDATE products SET category = COALESCE(NULLIF(?, ''), category),
                        base_unit = COALESCE(NULLIF(?, ''), base_unit),
                        notes = COALESCE(NULLIF(?, ''), notes)
    WHERE id = ?
  `);
  const findLink = db.prepare('SELECT * FROM product_suppliers WHERE product_id = ? AND supplier_id = ?');
  const insertLink = db.prepare(`
    INSERT INTO product_suppliers (product_id, supplier_id, sku, pack_size, pack_unit, unit_cost, is_primary)
    VALUES (@product_id, @supplier_id, @sku, @pack_size, @pack_unit, @unit_cost, @is_primary)
  `);
  const updateLink = db.prepare(`
    UPDATE product_suppliers SET sku = @sku, pack_size = @pack_size, pack_unit = @pack_unit, unit_cost = @unit_cost
    WHERE id = @id
  `);
  const upsertStoreProduct = db.prepare(`
    INSERT INTO store_products (store_id, product_id, par_level, reorder_point, on_hand, updated_at)
    VALUES (@store_id, @product_id, @par_level, @reorder_point, @on_hand, datetime('now'))
    ON CONFLICT (store_id, product_id) DO UPDATE SET
      par_level = excluded.par_level,
      reorder_point = excluded.reorder_point,
      on_hand = excluded.on_hand,
      updated_at = datetime('now')
  `);

  const run = db.transaction(() => {
    for (const row of rows) {
      const name = (row.product_name || '').trim();
      if (!name) { result.errors.push(`Line ${row.__line}: missing product name`); continue; }

      let product = findProduct.get(name);
      if (product) {
        updateProduct.run(row.category || '', row.base_unit || '', row.notes || '', product.id);
        result.products_updated++;
      } else {
        const id = insertProduct.run(
          name, row.category || '', row.base_unit || 'each', row.notes || '',
          row.active === undefined || row.active === '' ? 1 : (bool(row.active, true) ? 1 : 0),
        ).lastInsertRowid;
        product = findProduct.get(name);
        result.products_created++;
        void id;
      }

      if (row.supplier_name) {
        const before = db.prepare('SELECT COUNT(*) AS n FROM suppliers').get().n;
        const supplier = upsertSupplier(row.supplier_name);
        if (db.prepare('SELECT COUNT(*) AS n FROM suppliers').get().n > before) result.suppliers_created++;

        if (!row.sku) result.errors.push(`Line ${row.__line}: "${name}" has a supplier but no SKU`);
        const link = findLink.get(product.id, supplier.id);
        const payload = {
          product_id: product.id,
          supplier_id: supplier.id,
          sku: (row.sku || '').trim(),
          pack_size: num(row.pack_size, 1) || 1,
          pack_unit: row.pack_unit || 'case',
          unit_cost: num(row.unit_cost, 0),
          is_primary: 1,
        };
        try {
          if (link) { updateLink.run({ ...payload, id: link.id }); result.links_updated++; }
          else { insertLink.run(payload); result.links_created++; }
        } catch (err) {
          result.errors.push(`Line ${row.__line}: SKU "${payload.sku}" is already used by another product for ${supplier.name}`);
        }
      }

      const store = resolveStore(row.store_code) || (defaultStoreId ? db.prepare('SELECT * FROM stores WHERE id = ?').get(defaultStoreId) : null);
      const hasStoreData = ['par_level', 'reorder_point', 'on_hand'].some((k) => row[k] !== undefined && row[k] !== '');
      if (store && hasStoreData) {
        const existing = db.prepare('SELECT * FROM store_products WHERE store_id = ? AND product_id = ?').get(store.id, product.id);
        upsertStoreProduct.run({
          store_id: store.id,
          product_id: product.id,
          par_level: num(row.par_level, existing?.par_level ?? 0),
          reorder_point: num(row.reorder_point, existing?.reorder_point ?? 0),
          on_hand: num(row.on_hand, existing?.on_hand ?? 0),
        });
        result.store_rows++;
      } else if (row.store_code && !store) {
        result.errors.push(`Line ${row.__line}: unknown store "${row.store_code}"`);
      }
    }
  });

  run();
  return result;
}

/** Imports a counting sheet: one row per store/product/qty, matched by SKU or product name. */
function importCounts(csvText, { defaultStoreId = null, countedAt = null } = {}) {
  const { rows, unknown } = parseCsvObjects(csvText, COUNT_ALIASES);
  if (!rows.length) throw httpError(400, 'That CSV has no data rows');

  const result = { rows: rows.length, counts: 0, errors: [], unknown_columns: unknown };
  const bySku = db.prepare('SELECT product_id FROM product_suppliers WHERE sku = ? COLLATE NOCASE');
  const byName = db.prepare('SELECT id AS product_id FROM products WHERE name = ? COLLATE NOCASE');
  const insertCount = db.prepare('INSERT INTO counts (store_id, product_id, qty, counted_at, note) VALUES (?, ?, ?, ?, ?)');
  const setStock = db.prepare(`
    INSERT INTO store_products (store_id, product_id, on_hand, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (store_id, product_id) DO UPDATE SET on_hand = excluded.on_hand, updated_at = datetime('now')
  `);

  db.transaction(() => {
    for (const row of rows) {
      const store = resolveStore(row.store_code) || (defaultStoreId ? db.prepare('SELECT * FROM stores WHERE id = ?').get(defaultStoreId) : null);
      if (!store) { result.errors.push(`Line ${row.__line}: no store given and no default selected`); continue; }

      const match = (row.sku && bySku.get(row.sku.trim())) || (row.product_name && byName.get(row.product_name.trim()));
      if (!match) { result.errors.push(`Line ${row.__line}: no product matches "${row.sku || row.product_name}"`); continue; }
      if (row.qty === undefined || row.qty === '') { result.errors.push(`Line ${row.__line}: missing quantity`); continue; }

      const when = normaliseTimestamp(row.counted_at || countedAt);
      insertCount.run(store.id, match.product_id, num(row.qty), when, row.note || 'CSV import');
      setStock.run(store.id, match.product_id, num(row.qty));
      result.counts++;
    }
  })();

  return result;
}

function normaliseTimestamp(value) {
  if (!value) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 12:00:00`;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return s.replace('T', ' ').slice(0, 19);
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 19).replace('T', ' ');
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

const PRODUCT_EXPORT_COLUMNS = [
  { key: 'product_name', label: 'product_name' },
  { key: 'category', label: 'category' },
  { key: 'base_unit', label: 'base_unit' },
  { key: 'supplier_name', label: 'supplier_name' },
  { key: 'sku', label: 'sku' },
  { key: 'pack_size', label: 'pack_size' },
  { key: 'pack_unit', label: 'pack_unit' },
  { key: 'unit_cost', label: 'unit_cost' },
  { key: 'store_code', label: 'store_code' },
  { key: 'par_level', label: 'par_level' },
  { key: 'reorder_point', label: 'reorder_point' },
  { key: 'on_hand', label: 'on_hand' },
];

/** Exports the catalog in exactly the shape importProducts accepts, so it round-trips. */
function exportProductsCsv({ storeId = null } = {}) {
  // One row per stock record the store actually keeps, so re-importing the file does not
  // create empty par rows for stores that never carried the product.
  const rows = db.prepare(`
    SELECT p.name AS product_name, p.category, p.base_unit,
           COALESCE(v.name, '') AS supplier_name, COALESCE(ps.sku, '') AS sku,
           COALESCE(ps.pack_size, '') AS pack_size, COALESCE(ps.pack_unit, '') AS pack_unit,
           COALESCE(ps.unit_cost, '') AS unit_cost,
           COALESCE(s.code, '') AS store_code,
           CASE WHEN sp.store_id IS NULL THEN '' ELSE sp.par_level END     AS par_level,
           CASE WHEN sp.store_id IS NULL THEN '' ELSE sp.reorder_point END AS reorder_point,
           CASE WHEN sp.store_id IS NULL THEN '' ELSE sp.on_hand END       AS on_hand
    FROM products p
    LEFT JOIN product_suppliers ps ON ps.product_id = p.id
    LEFT JOIN suppliers v ON v.id = ps.supplier_id
    LEFT JOIN store_products sp ON sp.product_id = p.id
      AND (@storeId IS NULL OR sp.store_id = @storeId)
    LEFT JOIN stores s ON s.id = sp.store_id
    WHERE p.active = 1
    ORDER BY p.name, v.name, s.code
  `).all({ storeId: storeId ? Number(storeId) : null });
  return toCsv(PRODUCT_EXPORT_COLUMNS, rows);
}

module.exports = { importProducts, importCounts, exportProductsCsv, PRODUCT_ALIASES, COUNT_ALIASES, normaliseTimestamp };
