'use strict';

const { db, tx } = require('./db');
const { parseCsvObjects, toCsv, num, bool } = require('./csv');
const { httpError, stampFor } = require('./orders');

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

/**
 * Imports the product list: products, their supplier + SKU, pack sizes and costs,
 * and per-location par levels / current stock when those columns are present.
 * Re-importing the same file updates in place rather than duplicating.
 *
 * `allowedStoreIds` limits which locations the importer may touch, so a manager
 * cannot set pars for a location they have no access to.
 */
async function importProducts(accountId, csvText, { defaultStoreId = null, allowedStoreIds = null } = {}) {
  const { rows, unknown } = parseCsvObjects(csvText, PRODUCT_ALIASES);
  if (!rows.length) throw httpError(400, 'That CSV has no data rows');

  const result = {
    rows: rows.length,
    products_created: 0, products_updated: 0,
    suppliers_created: 0, links_created: 0, links_updated: 0,
    store_rows: 0, errors: [], unknown_columns: unknown,
  };

  const stores = await db.all('SELECT * FROM stores WHERE account_id = :account', { account: accountId });
  const storeFor = (token) => {
    const t = String(token || '').trim().toLowerCase();
    if (!t) return null;
    return stores.find((s) => s.code.toLowerCase() === t || s.name.toLowerCase() === t) || null;
  };

  await tx(async (t) => {
    const suppliers = new Map();

    for (const row of rows) {
      const name = (row.product_name || '').trim();
      if (!name) { result.errors.push(`Line ${row.__line}: missing product name`); continue; }

      const existing = await t.one(`
        SELECT * FROM products WHERE account_id = :account AND lower(name) = lower(:name)
      `, { account: accountId, name });

      let product;
      if (existing) {
        product = await t.one(`
          UPDATE products SET
            category = COALESCE(NULLIF(:category, ''), category),
            base_unit = COALESCE(NULLIF(:unit, ''), base_unit),
            notes = COALESCE(NULLIF(:notes, ''), notes)
          WHERE id = :id RETURNING *
        `, { category: row.category || '', unit: row.base_unit || '', notes: row.notes || '', id: existing.id });
        result.products_updated++;
      } else {
        product = await t.one(`
          INSERT INTO products (account_id, name, category, base_unit, notes, active)
          VALUES (:account, :name, :category, :unit, :notes, :active) RETURNING *
        `, {
          account: accountId, name, category: row.category || '',
          unit: row.base_unit || 'each', notes: row.notes || '',
          active: row.active === undefined || row.active === '' ? true : bool(row.active, true),
        });
        result.products_created++;
      }

      if (row.supplier_name) {
        const supplierName = String(row.supplier_name).trim();
        let supplier = suppliers.get(supplierName.toLowerCase());
        if (!supplier) {
          supplier = await t.one('SELECT * FROM suppliers WHERE account_id = :account AND lower(name) = lower(:name)',
            { account: accountId, name: supplierName });
          if (!supplier) {
            supplier = await t.one('INSERT INTO suppliers (account_id, name) VALUES (:account, :name) RETURNING *',
              { account: accountId, name: supplierName });
            result.suppliers_created++;
          }
          suppliers.set(supplierName.toLowerCase(), supplier);
        }

        if (!row.sku) result.errors.push(`Line ${row.__line}: "${name}" has a supplier but no SKU`);

        const payload = {
          account: accountId,
          product: product.id,
          supplier: supplier.id,
          sku: (row.sku || '').trim(),
          packSize: num(row.pack_size, 1) || 1,
          packUnit: row.pack_unit || 'case',
          cost: num(row.unit_cost, 0),
        };

        const link = await t.one('SELECT * FROM product_suppliers WHERE product_id = :product AND supplier_id = :supplier',
          { product: product.id, supplier: supplier.id });
        try {
          if (link) {
            await t.run(`UPDATE product_suppliers SET sku = :sku, pack_size = :packSize,
                         pack_unit = :packUnit, unit_cost = :cost WHERE id = :id`, { ...payload, id: link.id });
            result.links_updated++;
          } else {
            await t.run(`INSERT INTO product_suppliers (account_id, product_id, supplier_id, sku, pack_size, pack_unit, unit_cost, is_primary)
                         VALUES (:account, :product, :supplier, :sku, :packSize, :packUnit, :cost, true)`, payload);
            result.links_created++;
          }
        } catch (err) {
          if (!/duplicate key/i.test(err.message)) throw err;
          result.errors.push(`Line ${row.__line}: SKU "${payload.sku}" is already used by another product for ${supplier.name}`);
        }
      }

      const store = storeFor(row.store_code)
        || (defaultStoreId ? stores.find((s) => s.id === Number(defaultStoreId)) : null);
      const hasStoreData = ['par_level', 'reorder_point', 'on_hand'].some((k) => row[k] !== undefined && row[k] !== '');

      if (store && hasStoreData) {
        if (allowedStoreIds && !allowedStoreIds.includes(store.id)) {
          result.errors.push(`Line ${row.__line}: you do not have access to ${store.name}`);
          continue;
        }
        const current = await t.one('SELECT * FROM store_products WHERE store_id = :store AND product_id = :product',
          { store: store.id, product: product.id });
        await t.run(`
          INSERT INTO store_products (account_id, store_id, product_id, par_level, reorder_point, on_hand, updated_at)
          VALUES (:account, :store, :product, :par, :reorder, :onHand, now())
          ON CONFLICT (store_id, product_id) DO UPDATE SET
            par_level = excluded.par_level, reorder_point = excluded.reorder_point,
            on_hand = excluded.on_hand, updated_at = now()
        `, {
          account: accountId, store: store.id, product: product.id,
          par: num(row.par_level, current?.par_level ?? 0),
          reorder: num(row.reorder_point, current?.reorder_point ?? 0),
          onHand: num(row.on_hand, current?.on_hand ?? 0),
        });
        result.store_rows++;
      } else if (row.store_code && !store) {
        result.errors.push(`Line ${row.__line}: unknown location "${row.store_code}"`);
      }
    }
  });

  return result;
}

/** Imports a counting sheet: one row per location/product/qty, matched by SKU or product name. */
async function importCounts(accountId, csvText, { defaultStoreId = null, countedAt = null, allowedStoreIds = null, countedBy = null } = {}) {
  const { rows, unknown } = parseCsvObjects(csvText, COUNT_ALIASES);
  if (!rows.length) throw httpError(400, 'That CSV has no data rows');

  const result = { rows: rows.length, counts: 0, errors: [], unknown_columns: unknown };
  const stores = await db.all('SELECT * FROM stores WHERE account_id = :account', { account: accountId });
  const storeFor = (token) => {
    const t = String(token || '').trim().toLowerCase();
    if (!t) return null;
    return stores.find((s) => s.code.toLowerCase() === t || s.name.toLowerCase() === t) || null;
  };

  await tx(async (t) => {
    for (const row of rows) {
      const store = storeFor(row.store_code) || (defaultStoreId ? stores.find((s) => s.id === Number(defaultStoreId)) : null);
      if (!store) { result.errors.push(`Line ${row.__line}: no location given and no default selected`); continue; }
      if (allowedStoreIds && !allowedStoreIds.includes(store.id)) {
        result.errors.push(`Line ${row.__line}: you do not have access to ${store.name}`);
        continue;
      }

      let match = null;
      if (row.sku) {
        match = await t.one(`
          SELECT product_id FROM product_suppliers
          WHERE account_id = :account AND lower(sku) = lower(:sku) LIMIT 1
        `, { account: accountId, sku: row.sku.trim() });
      }
      if (!match && row.product_name) {
        match = await t.one(`
          SELECT id AS product_id FROM products WHERE account_id = :account AND lower(name) = lower(:name)
        `, { account: accountId, name: row.product_name.trim() });
      }
      if (!match) { result.errors.push(`Line ${row.__line}: no product matches "${row.sku || row.product_name}"`); continue; }
      if (row.qty === undefined || row.qty === '') { result.errors.push(`Line ${row.__line}: missing quantity`); continue; }

      const when = stampFor(row.counted_at || countedAt || new Date().toISOString());
      await t.run(`
        INSERT INTO counts (account_id, store_id, product_id, qty, counted_at, counted_by, note)
        VALUES (:account, :store, :product, :qty, :at, :by, :note)
      `, {
        account: accountId, store: store.id, product: match.product_id,
        qty: num(row.qty), at: when, by: countedBy, note: row.note || 'CSV import',
      });
      await t.run(`
        INSERT INTO store_products (account_id, store_id, product_id, on_hand, updated_at)
        VALUES (:account, :store, :product, :qty, now())
        ON CONFLICT (store_id, product_id) DO UPDATE SET on_hand = excluded.on_hand, updated_at = now()
      `, { account: accountId, store: store.id, product: match.product_id, qty: num(row.qty) });

      result.counts++;
    }
  });

  return result;
}

const PRODUCT_EXPORT_COLUMNS = [
  'product_name', 'category', 'base_unit', 'supplier_name', 'sku', 'pack_size',
  'pack_unit', 'unit_cost', 'store_code', 'par_level', 'reorder_point', 'on_hand',
].map((key) => ({ key, label: key }));

/** Exports the catalogue in exactly the shape importProducts accepts, so it round-trips. */
async function exportProductsCsv(accountId, { storeIds = null } = {}) {
  const rows = await db.all(`
    SELECT p.name AS product_name, p.category, p.base_unit,
           COALESCE(v.name, '') AS supplier_name, COALESCE(ps.sku, '') AS sku,
           COALESCE(ps.pack_size::text, '') AS pack_size, COALESCE(ps.pack_unit, '') AS pack_unit,
           COALESCE(ps.unit_cost::text, '') AS unit_cost,
           COALESCE(s.code, '') AS store_code,
           COALESCE(sp.par_level::text, '') AS par_level,
           COALESCE(sp.reorder_point::text, '') AS reorder_point,
           COALESCE(sp.on_hand::text, '') AS on_hand
    FROM products p
    LEFT JOIN product_suppliers ps ON ps.product_id = p.id
    LEFT JOIN suppliers v ON v.id = ps.supplier_id
    LEFT JOIN store_products sp ON sp.product_id = p.id
      AND (:storeIds::bigint[] IS NULL OR sp.store_id = ANY(:storeIds))
    LEFT JOIN stores s ON s.id = sp.store_id
    WHERE p.account_id = :account AND p.active
    ORDER BY p.name, v.name, s.code
  `, { account: accountId, storeIds: storeIds && storeIds.length ? storeIds : null });

  return toCsv(PRODUCT_EXPORT_COLUMNS, rows);
}

module.exports = { importProducts, importCounts, exportProductsCsv, PRODUCT_ALIASES, COUNT_ALIASES };
