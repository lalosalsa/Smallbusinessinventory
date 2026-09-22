'use strict';

const express = require('express');
const { db, tx } = require('./db');
const auth = require('./auth');
const accounts = require('./accounts');
const { usageReport, usageSegments, round } = require('./usage');
const { suggestOrder, createOrder, getOrder, receiveOrder, orderToCsv, suggestionToCsv, stampFor, httpError } = require('./orders');
const schedules = require('./schedules');
const { importProducts, importCounts, exportProductsCsv } = require('./importer');
const { toCsv } = require('./csv');

const router = express.Router();

/* ------------------------------------------------------------ sign-in layer */

/** Reads the bearer token, if there is one, and hangs the user and membership off the request. */
router.use(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  req.token = token || null;
  req.user = token ? await auth.verifyToken(token) : null;
  req.member = req.user ? await accounts.membershipFor(req.user) : null;
  next();
});

function requireUser(req) {
  if (!req.user) throw httpError(401, 'Sign in to continue');
  return req.user;
}

function requireMember(req, action = 'view') {
  requireUser(req);
  if (!req.member) throw httpError(403, 'Your sign-in is not attached to an account yet');
  accounts.assertCan(req.member, action);
  return req.member;
}

/** The locations this request may touch: the one asked for, or all the member can reach. */
function scopeStores(member, requestedStoreId) {
  if (requestedStoreId) return [accounts.assertStoreAccess(member, requestedStoreId)];
  return member.store_ids;
}

router.get('/auth/config', (req, res) => res.json(auth.publicConfig()));

router.post('/auth/register', async (req, res) => {
  const { email, password, display_name = '' } = req.body || {};
  res.status(201).json(await auth.registerLocalUser({ email, password, display_name }));
});

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  res.json(await auth.loginLocal({ email, password }));
});

router.post('/auth/password', async (req, res) => {
  const user = requireUser(req);
  res.json(await auth.changeLocalPassword(user.id, req.body || {}));
});

router.post('/auth/logout', (req, res) => {
  if (req.token) auth.forgetToken(req.token);
  res.json({ ok: true });
});

/** Who am I, what account am I on, and what am I allowed to do. */
router.get('/auth/me', async (req, res) => {
  if (!req.user) return res.json({ user: null, member: null, mode: auth.authMode() });
  const member = req.member;
  const stores = member
    ? await db.all('SELECT * FROM stores WHERE account_id = :account AND id = ANY(:ids) ORDER BY name',
      { account: member.account_id, ids: member.store_ids.length ? member.store_ids : [0] })
    : [];
  res.json({
    mode: auth.authMode(),
    user: req.user,
    member: member && {
      id: member.id,
      account_id: member.account_id,
      account_name: member.account_name,
      email: member.email,
      display_name: member.display_name,
      role: member.role,
      all_locations: member.all_locations,
      permissions: member.permissions,
      store_ids: member.store_ids,
    },
    stores,
  });
});

/** First run: a signed-in person with no account creates the business. */
router.post('/accounts', async (req, res) => {
  const user = requireUser(req);
  const { name, locations } = req.body || {};
  const member = await accounts.createAccount(user, { name, locations });
  res.status(201).json(member);
});

router.put('/accounts', async (req, res) => {
  const member = requireMember(req, 'manage_account');
  const { name } = req.body || {};
  if (!String(name || '').trim()) throw httpError(400, 'Give the business a name');
  res.json(await db.one('UPDATE accounts SET name = :name WHERE id = :id RETURNING *',
    { name: String(name).trim(), id: member.account_id }));
});

/* ------------------------------------------------------------------ people */

router.get('/members', async (req, res) => {
  const member = requireMember(req, 'view');
  res.json({
    members: await accounts.listMembers(member.account_id),
    invites: accounts.can(member, 'manage_account') ? await accounts.listInvites(member.account_id) : [],
    roles: accounts.ROLES,
    me: member.id,
  });
});

/** Creates a join code to hand out. */
router.post('/members/invite', async (req, res) => {
  const member = requireMember(req, 'manage_account');
  res.status(201).json(await accounts.createInvite(member, req.body || {}));
});

router.put('/members/:id', async (req, res) => {
  const member = requireMember(req, 'manage_account');
  res.json(await accounts.updateMember(member, req.params.id, req.body || {}));
});

router.delete('/members/:id', async (req, res) => {
  const member = requireMember(req, 'manage_account');
  res.json(await accounts.removeMember(member, req.params.id));
});

/** Turns a code off without losing the record of who it was for. */
router.post('/invites/:id/revoke', async (req, res) => {
  const member = requireMember(req, 'manage_account');
  res.json(await accounts.revokeInvite(member, req.params.id));
});

router.delete('/invites/:id', async (req, res) => {
  const member = requireMember(req, 'manage_account');
  res.json(await accounts.deleteInvite(member, req.params.id));
});

/** What a join code is for — shown before anyone commits to using it. */
router.get('/join/:code', async (req, res) => {
  res.json(await accounts.describeCode(req.params.code, req.user?.email || null));
});

/** Joins the signed-in person to the account a code belongs to. */
router.post('/join', async (req, res) => {
  const user = requireUser(req);
  const { code } = req.body || {};
  if (!code) throw httpError(400, 'Enter the join code you were given');
  res.status(201).json(await accounts.redeemCode(user, code));
});

/* --------------------------------------------------------------- locations */

router.get('/stores', async (req, res) => {
  const member = requireMember(req, 'view');
  res.json(await db.all(`
    SELECT * FROM stores WHERE account_id = :account AND id = ANY(:ids) ORDER BY name
  `, { account: member.account_id, ids: member.store_ids.length ? member.store_ids : [0] }));
});

router.post('/stores', async (req, res) => {
  const member = requireMember(req, 'manage_account');
  const { name, code, address = '' } = req.body || {};
  if (!name || !code) throw httpError(400, 'A location needs a name and a short code');
  res.status(201).json(await db.one(`
    INSERT INTO stores (account_id, name, code, address) VALUES (:account, :name, :code, :address) RETURNING *
  `, { account: member.account_id, name: String(name).trim(), code: String(code).trim().toUpperCase(), address }));
});

router.put('/stores/:id', async (req, res) => {
  const member = requireMember(req, 'manage_account');
  const { name, code, address = '', active = true } = req.body || {};
  const store = await db.one(`
    UPDATE stores SET name = :name, code = :code, address = :address, active = :active
    WHERE id = :id AND account_id = :account RETURNING *
  `, { name, code: String(code).toUpperCase(), address, active: !!active, id: req.params.id, account: member.account_id });
  if (!store) throw httpError(404, 'Location not found');
  res.json(store);
});

router.delete('/stores/:id', async (req, res) => {
  const member = requireMember(req, 'manage_account');
  const remaining = await db.value('SELECT count(*)::int FROM stores WHERE account_id = :account', { account: member.account_id });
  if (remaining <= 1) throw httpError(400, 'An account needs at least one location');
  await db.run('DELETE FROM stores WHERE id = :id AND account_id = :account', { id: req.params.id, account: member.account_id });
  res.json({ ok: true });
});

/* --------------------------------------------------------------- suppliers */

const SUPPLIER_FIELDS = {
  name: 'name', contact_name: 'contactName', email: 'email', phone: 'phone',
  account_number: 'accountNumber', order_days: 'orderDays', lead_time_days: 'leadTime',
  min_order_value: 'minOrder', notes: 'notes', active: 'active',
};

function supplierPayload(body) {
  return {
    name: String(body.name || '').trim(),
    contactName: body.contact_name || '',
    email: body.email || '',
    phone: body.phone || '',
    accountNumber: body.account_number || '',
    orderDays: body.order_days || '',
    leadTime: Number(body.lead_time_days) || 0,
    minOrder: Number(body.min_order_value) || 0,
    notes: body.notes || '',
    active: body.active === false ? false : true,
  };
}

router.get('/suppliers', async (req, res) => {
  const member = requireMember(req, 'view');
  res.json(await db.all(`
    SELECT v.*, (SELECT count(*)::int FROM product_suppliers ps WHERE ps.supplier_id = v.id) AS product_count
    FROM suppliers v WHERE v.account_id = :account ORDER BY v.name
  `, { account: member.account_id }));
});

router.post('/suppliers', async (req, res) => {
  const member = requireMember(req, 'manage_catalog');
  const payload = supplierPayload(req.body || {});
  if (!payload.name) throw httpError(400, 'A supplier needs a name');
  const columns = Object.keys(SUPPLIER_FIELDS);
  res.status(201).json(await db.one(`
    INSERT INTO suppliers (account_id, ${columns.join(', ')})
    VALUES (:account, ${columns.map((c) => `:${SUPPLIER_FIELDS[c]}`).join(', ')}) RETURNING *
  `, { ...payload, account: member.account_id }));
});

router.put('/suppliers/:id', async (req, res) => {
  const member = requireMember(req, 'manage_catalog');
  const payload = supplierPayload(req.body || {});
  const sets = Object.keys(SUPPLIER_FIELDS).map((c) => `${c} = :${SUPPLIER_FIELDS[c]}`).join(', ');
  const supplier = await db.one(`UPDATE suppliers SET ${sets} WHERE id = :id AND account_id = :account RETURNING *`,
    { ...payload, id: req.params.id, account: member.account_id });
  if (!supplier) throw httpError(404, 'Supplier not found');
  res.json(supplier);
});

router.delete('/suppliers/:id', async (req, res) => {
  const member = requireMember(req, 'manage_catalog');
  await db.run('DELETE FROM suppliers WHERE id = :id AND account_id = :account', { id: req.params.id, account: member.account_id });
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- products */

router.get('/products', async (req, res) => {
  const member = requireMember(req, 'view');
  const { search = '', supplier_id = '', category = '' } = req.query;

  const products = await db.all(`
    SELECT p.* FROM products p WHERE p.account_id = :account ORDER BY p.category, p.name
  `, { account: member.account_id });

  const links = await db.all(`
    SELECT ps.*, v.name AS supplier_name FROM product_suppliers ps
    JOIN suppliers v ON v.id = ps.supplier_id WHERE ps.account_id = :account
  `, { account: member.account_id });

  const stock = await db.all(`
    SELECT * FROM store_products WHERE account_id = :account AND store_id = ANY(:ids)
  `, { account: member.account_id, ids: member.store_ids.length ? member.store_ids : [0] });

  let list = products.map((p) => ({
    ...p,
    suppliers: links.filter((l) => l.product_id === p.id),
    stock: stock.filter((s) => s.product_id === p.id),
  }));

  if (search) {
    const q = String(search).toLowerCase();
    list = list.filter((p) => p.name.toLowerCase().includes(q)
      || (p.category || '').toLowerCase().includes(q)
      || p.suppliers.some((l) => (l.sku || '').toLowerCase().includes(q)));
  }
  if (category) list = list.filter((p) => (p.category || '') === category);
  if (supplier_id) list = list.filter((p) => p.suppliers.some((l) => String(l.supplier_id) === String(supplier_id)));

  res.json(list);
});

router.get('/categories', async (req, res) => {
  const member = requireMember(req, 'view');
  const rows = await db.all(`
    SELECT DISTINCT category FROM products WHERE account_id = :account AND category <> '' ORDER BY category
  `, { account: member.account_id });
  res.json(rows.map((r) => r.category));
});

router.post('/products', async (req, res) => {
  const member = requireMember(req, 'manage_catalog');
  const { name, category = '', base_unit = 'each', notes = '', suppliers = [], stock = [] } = req.body || {};
  if (!name) throw httpError(400, 'A product needs a name');

  const product = await tx(async (t) => {
    const created = await t.one(`
      INSERT INTO products (account_id, name, category, base_unit, notes)
      VALUES (:account, :name, :category, :unit, :notes) RETURNING *
    `, { account: member.account_id, name: String(name).trim(), category, unit: base_unit, notes });
    await saveProductLinks(t, member, created.id, suppliers);
    await saveProductStock(t, member, created.id, stock);
    return created;
  });
  res.status(201).json(product);
});

router.put('/products/:id', async (req, res) => {
  const member = requireMember(req, 'manage_catalog');
  const id = Number(req.params.id);
  const { name, category = '', base_unit = 'each', notes = '', active = true, suppliers, stock } = req.body || {};

  const product = await tx(async (t) => {
    const updated = await t.one(`
      UPDATE products SET name = :name, category = :category, base_unit = :unit, notes = :notes, active = :active
      WHERE id = :id AND account_id = :account RETURNING *
    `, { name, category, unit: base_unit, notes, active: !!active, id, account: member.account_id });
    if (!updated) throw httpError(404, 'Product not found');
    if (Array.isArray(suppliers)) await saveProductLinks(t, member, id, suppliers, true);
    if (Array.isArray(stock)) await saveProductStock(t, member, id, stock);
    return updated;
  });
  res.json(product);
});

router.delete('/products/:id', async (req, res) => {
  const member = requireMember(req, 'manage_catalog');
  await db.run('DELETE FROM products WHERE id = :id AND account_id = :account', { id: req.params.id, account: member.account_id });
  res.json({ ok: true });
});

async function saveProductLinks(t, member, productId, links, replace = false) {
  if (replace) {
    const keep = links.map((l) => Number(l.id)).filter(Boolean);
    await t.run(`
      DELETE FROM product_suppliers WHERE product_id = :product AND account_id = :account
        AND (:keep::bigint[] IS NULL OR NOT (id = ANY(:keep)))
    `, { product: productId, account: member.account_id, keep: keep.length ? keep : null });
  }

  for (const link of links) {
    if (!link.supplier_id || !link.sku) continue;
    const payload = {
      account: member.account_id,
      product: productId,
      supplier: Number(link.supplier_id),
      sku: String(link.sku).trim(),
      packSize: Number(link.pack_size) || 1,
      packUnit: link.pack_unit || 'case',
      cost: Number(link.unit_cost) || 0,
      primary: !!link.is_primary,
    };
    await t.run(`
      INSERT INTO product_suppliers (account_id, product_id, supplier_id, sku, pack_size, pack_unit, unit_cost, is_primary)
      VALUES (:account, :product, :supplier, :sku, :packSize, :packUnit, :cost, :primary)
      ON CONFLICT (product_id, supplier_id) DO UPDATE SET
        sku = excluded.sku, pack_size = excluded.pack_size, pack_unit = excluded.pack_unit,
        unit_cost = excluded.unit_cost, is_primary = excluded.is_primary
    `, payload);
  }
}

async function saveProductStock(t, member, productId, stock) {
  for (const row of stock || []) {
    if (!row.store_id) continue;
    const storeId = accounts.assertStoreAccess(member, row.store_id);
    await t.run(`
      INSERT INTO store_products (account_id, store_id, product_id, par_level, reorder_point, on_hand, updated_at)
      VALUES (:account, :store, :product, :par, :reorder, :onHand, now())
      ON CONFLICT (store_id, product_id) DO UPDATE SET
        par_level = excluded.par_level, reorder_point = excluded.reorder_point,
        on_hand = excluded.on_hand, updated_at = now()
    `, {
      account: member.account_id, store: storeId, product: productId,
      par: Number(row.par_level) || 0,
      reorder: Number(row.reorder_point) || 0,
      onHand: Number(row.on_hand) || 0,
    });
  }
}

/* --------------------------------------------------------------- inventory */

router.get('/inventory', async (req, res) => {
  const member = requireMember(req, 'view');
  const storeId = accounts.assertStoreAccess(member, req.query.store_id);
  const { search = '', supplier_id = '', category = '', only = '' } = req.query;

  let rows = await db.all(`
    SELECT p.id AS product_id, p.name AS product_name, p.category, p.base_unit,
           COALESCE(sp.on_hand, 0) AS on_hand,
           COALESCE(sp.par_level, 0) AS par_level,
           COALESCE(sp.reorder_point, 0) AS reorder_point,
           sp.updated_at,
           ps.supplier_id, v.name AS supplier_name, ps.sku, ps.pack_size, ps.pack_unit, ps.unit_cost,
           (SELECT max(counted_at) FROM counts c WHERE c.store_id = :storeId AND c.product_id = p.id) AS last_counted
    FROM products p
    LEFT JOIN store_products sp ON sp.product_id = p.id AND sp.store_id = :storeId
    LEFT JOIN product_suppliers ps ON ps.product_id = p.id AND ps.is_primary
    LEFT JOIN suppliers v ON v.id = ps.supplier_id
    WHERE p.account_id = :account AND p.active
    ORDER BY p.category, p.name
  `, { storeId, account: member.account_id });

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
router.post('/counts', async (req, res) => {
  const member = requireMember(req, 'count');
  const { store_id, counted_at = null, note = '', lines = [] } = req.body || {};
  const storeId = accounts.assertStoreAccess(member, store_id);

  const clean = lines.filter((l) => l.qty !== '' && l.qty != null && !Number.isNaN(Number(l.qty)));
  if (!clean.length) throw httpError(400, 'No counted quantities were submitted');
  const when = stampFor(counted_at || new Date().toISOString());

  await tx(async (t) => {
    for (const line of clean) {
      await t.run(`
        INSERT INTO counts (account_id, store_id, product_id, qty, counted_at, counted_by, note)
        VALUES (:account, :store, :product, :qty, :at, :by, :note)
      `, { account: member.account_id, store: storeId, product: line.product_id, qty: Number(line.qty), at: when, by: member.id, note });

      await t.run(`
        INSERT INTO store_products (account_id, store_id, product_id, on_hand, updated_at)
        VALUES (:account, :store, :product, :qty, now())
        ON CONFLICT (store_id, product_id) DO UPDATE SET on_hand = excluded.on_hand, updated_at = now()
      `, { account: member.account_id, store: storeId, product: line.product_id, qty: Number(line.qty) });
    }
  });

  res.status(201).json({ saved: clean.length, counted_at: when });
});

router.get('/counts', async (req, res) => {
  const member = requireMember(req, 'view');
  const storeIds = scopeStores(member, req.query.store_id);
  res.json(await db.all(`
    SELECT c.*, p.name AS product_name, s.name AS store_name,
           (SELECT email FROM members WHERE id = c.counted_by) AS counted_by_email
    FROM counts c
    JOIN products p ON p.id = c.product_id
    JOIN stores s   ON s.id = c.store_id
    WHERE c.account_id = :account AND c.store_id = ANY(:ids)
      AND (:productId::bigint IS NULL OR c.product_id = :productId)
    ORDER BY c.counted_at DESC, c.id DESC LIMIT :limit
  `, {
    account: member.account_id,
    ids: storeIds.length ? storeIds : [0],
    productId: req.query.product_id ? Number(req.query.product_id) : null,
    limit: Number(req.query.limit) || 200,
  }));
});

/** Stock arriving outside an order: a walk-in buy, a transfer, a credit. */
router.post('/receipts', async (req, res) => {
  const member = requireMember(req, 'count');
  const { store_id, product_id, qty, received_at = null, note = '' } = req.body || {};
  const storeId = accounts.assertStoreAccess(member, store_id);
  if (!product_id || qty == null) throw httpError(400, 'product_id and qty are required');
  const when = stampFor(received_at || new Date().toISOString());

  await tx(async (t) => {
    await t.run(`
      INSERT INTO receipts (account_id, store_id, product_id, qty, received_at, note)
      VALUES (:account, :store, :product, :qty, :at, :note)
    `, { account: member.account_id, store: storeId, product: product_id, qty: Number(qty), at: when, note });

    await t.run(`
      INSERT INTO store_products (account_id, store_id, product_id, on_hand, updated_at)
      VALUES (:account, :store, :product, :qty, now())
      ON CONFLICT (store_id, product_id) DO UPDATE
        SET on_hand = round(store_products.on_hand + excluded.on_hand, 4), updated_at = now()
    `, { account: member.account_id, store: storeId, product: product_id, qty: Number(qty) });
  });

  res.status(201).json({ ok: true });
});

/* ------------------------------------------------------------------- usage */

async function usageFor(req) {
  const member = requireMember(req, 'view');
  const { from, to, product_id = '', group_by = 'total', category = '' } = req.query;
  if (!from || !to) throw httpError(400, 'from and to dates are required');
  const storeIds = scopeStores(member, req.query.store_id);

  return usageReport({
    accountId: member.account_id,
    from,
    to,
    storeIds,
    productId: product_id || null,
    groupBy: group_by,
    category: category || null,
  });
}

router.get('/usage', async (req, res) => res.json(await usageFor(req)));

router.get('/usage/export.csv', async (req, res) => {
  const report = await usageFor(req);
  const columns = [
    { key: 'store_name', label: 'Location' },
    { key: 'product_name', label: 'Product' },
    { key: 'category', label: 'Category' },
    { key: 'base_unit', label: 'Unit' },
    { key: 'used', label: `Used ${report.from} to ${report.to}` },
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
  sendCsv(res, `usage-${report.from}_to_${report.to}.csv`, toCsv(columns, rows));
});

router.get('/usage/segments', async (req, res) => {
  const member = requireMember(req, 'view');
  const { from, to, product_id = '' } = req.query;
  if (!from || !to) throw httpError(400, 'from and to dates are required');
  res.json(await usageSegments({
    accountId: member.account_id,
    from,
    to,
    storeIds: scopeStores(member, req.query.store_id),
    productId: product_id || null,
  }));
});

/* ------------------------------------------------------------------ orders */

router.post('/orders/suggest', async (req, res) => {
  const member = requireMember(req, 'manage_orders');
  const { store_id, supplier_id, mode = 'both', days_of_cover = 7, lookback_days = 28, only_needed = true } = req.body || {};
  if (!supplier_id) throw httpError(400, 'supplier_id is required');
  res.json(await suggestOrder({
    accountId: member.account_id,
    storeId: accounts.assertStoreAccess(member, store_id),
    supplierId: Number(supplier_id),
    mode,
    daysOfCover: Number(days_of_cover) || 7,
    lookbackDays: Number(lookback_days) || 28,
    onlyNeeded: only_needed !== false,
  }));
});

/** A supplier's order sheet as CSV without saving an order first. */
router.get('/orders/sheet.csv', async (req, res) => {
  const member = requireMember(req, 'manage_orders');
  const { store_id, supplier_id, mode = 'both', days_of_cover = 7, lookback_days = 28 } = req.query;
  if (!supplier_id) throw httpError(400, 'supplier_id is required');

  const sheet = await suggestOrder({
    accountId: member.account_id,
    storeId: accounts.assertStoreAccess(member, store_id),
    supplierId: Number(supplier_id),
    mode,
    daysOfCover: Number(days_of_cover) || 7,
    lookbackDays: Number(lookback_days) || 28,
    onlyNeeded: true,
  });
  sendCsv(res, `order-sheet-${slug(sheet.supplier.name)}-${slug(sheet.store.code)}.csv`, suggestionToCsv(sheet));
});

router.get('/orders', async (req, res) => {
  const member = requireMember(req, 'view');
  const storeIds = scopeStores(member, req.query.store_id);
  res.json(await db.all(`
    SELECT o.*, s.name AS store_name, v.name AS supplier_name,
           (SELECT count(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS line_count,
           (SELECT round(sum(oi.qty_packs * oi.unit_cost), 2) FROM order_items oi WHERE oi.order_id = o.id) AS total
    FROM orders o JOIN stores s ON s.id = o.store_id JOIN suppliers v ON v.id = o.supplier_id
    WHERE o.account_id = :account AND o.store_id = ANY(:ids)
      AND (:status::text IS NULL OR o.status = :status)
    ORDER BY o.created_at DESC, o.id DESC
  `, {
    account: member.account_id,
    ids: storeIds.length ? storeIds : [0],
    status: req.query.status || null,
  }));
});

router.post('/orders', async (req, res) => {
  const member = requireMember(req, 'manage_orders');
  const { store_id, supplier_id, note = '', lines = [] } = req.body || {};
  if (!supplier_id) throw httpError(400, 'supplier_id is required');
  res.status(201).json(await createOrder({
    accountId: member.account_id,
    storeId: accounts.assertStoreAccess(member, store_id),
    supplierId: Number(supplier_id),
    note,
    lines,
    createdBy: member.id,
  }));
});

async function loadOrder(req, action = 'view') {
  const member = requireMember(req, action);
  const order = await getOrder(member.account_id, Number(req.params.id));
  if (!order) throw httpError(404, 'Order not found');
  accounts.assertStoreAccess(member, order.store_id);
  return { member, order };
}

router.get('/orders/:id', async (req, res) => {
  const { order } = await loadOrder(req);
  res.json(order);
});

router.put('/orders/:id', async (req, res) => {
  const { member, order } = await loadOrder(req, 'manage_orders');
  const { note, lines } = req.body || {};

  await tx(async (t) => {
    if (note !== undefined) await t.run('UPDATE orders SET note = :note WHERE id = :id', { note, id: order.id });
    if (Array.isArray(lines)) {
      await t.run('DELETE FROM order_items WHERE order_id = :id', { id: order.id });
      for (const line of lines) {
        if (!(Number(line.qty_packs) > 0)) continue;
        await t.run(`
          INSERT INTO order_items (order_id, product_id, sku, pack_size, pack_unit, qty_packs, unit_cost)
          VALUES (:order, :product, :sku, :packSize, :packUnit, :qty, :cost)
        `, {
          order: order.id, product: Number(line.product_id), sku: line.sku || '',
          packSize: Number(line.pack_size) || 1, packUnit: line.pack_unit || 'case',
          qty: Number(line.qty_packs), cost: Number(line.unit_cost) || 0,
        });
      }
    }
  });

  res.json(await getOrder(member.account_id, order.id));
});

router.post('/orders/:id/status', async (req, res) => {
  const { member, order } = await loadOrder(req, 'manage_orders');
  const { status } = req.body || {};
  if (!['draft', 'sent', 'received', 'cancelled'].includes(status)) throw httpError(400, 'Unknown status');
  if (status === 'received') return res.json(await receiveOrder(member.account_id, order.id));

  await db.run(`
    UPDATE orders SET status = :status,
      sent_at = CASE WHEN :status = 'sent' THEN now() ELSE sent_at END
    WHERE id = :id
  `, { status, id: order.id });
  res.json(await getOrder(member.account_id, order.id));
});

router.post('/orders/:id/receive', async (req, res) => {
  const { member, order } = await loadOrder(req, 'manage_orders');
  const { received_at = null, lines = null } = req.body || {};
  res.json(await receiveOrder(member.account_id, order.id, { receivedAt: received_at, lines }));
});

router.delete('/orders/:id', async (req, res) => {
  const { member, order } = await loadOrder(req, 'manage_orders');
  await db.run('DELETE FROM orders WHERE id = :id AND account_id = :account', { id: order.id, account: member.account_id });
  res.json({ ok: true });
});

router.get('/orders/:id/export.csv', async (req, res) => {
  const { order } = await loadOrder(req);
  sendCsv(res, `order-${order.id}-${slug(order.supplier_name)}-${slug(order.store_code)}.csv`, orderToCsv(order));
});

/* --------------------------------------------------------------- schedules */

router.get('/schedules', async (req, res) => {
  const member = requireMember(req, 'view');
  res.json(await schedules.listSchedules({
    accountId: member.account_id,
    activeOnly: req.query.active === '1',
    storeIds: scopeStores(member, req.query.store_id),
  }));
});

router.get('/schedules/upcoming', async (req, res) => {
  const member = requireMember(req, 'view');
  res.json(await schedules.upcoming(member.account_id, Number(req.query.days) || 30, { storeIds: member.store_ids }));
});

/** Raises drafts for every schedule that is due — the "catch me up" button. */
router.post('/schedules/run-due', async (req, res) => {
  const member = requireMember(req, 'manage_orders');
  res.json({ runs: await schedules.runDueSchedules(member.account_id, { storeIds: member.store_ids, createdBy: member.id }) });
});

router.post('/schedules', async (req, res) => {
  const member = requireMember(req, 'manage_orders');
  accounts.assertStoreAccess(member, (req.body || {}).store_id);
  res.status(201).json(await schedules.saveSchedule(member.account_id, req.body || {}));
});

router.get('/schedules/:id', async (req, res) => {
  const member = requireMember(req, 'view');
  const schedule = await schedules.getSchedule(member.account_id, Number(req.params.id));
  if (!schedule) throw httpError(404, 'Schedule not found');
  accounts.assertStoreAccess(member, schedule.store_id);
  res.json(schedule);
});

router.put('/schedules/:id', async (req, res) => {
  const member = requireMember(req, 'manage_orders');
  accounts.assertStoreAccess(member, (req.body || {}).store_id);
  res.json(await schedules.saveSchedule(member.account_id, req.body || {}, Number(req.params.id)));
});

router.delete('/schedules/:id', async (req, res) => {
  const member = requireMember(req, 'manage_orders');
  await db.run('DELETE FROM order_schedules WHERE id = :id AND account_id = :account',
    { id: req.params.id, account: member.account_id });
  res.json({ ok: true });
});

/** Build the draft this schedule is due for (force = run it early, skip = pass on it). */
router.post('/schedules/:id/run', async (req, res) => {
  const member = requireMember(req, 'manage_orders');
  const schedule = await schedules.getSchedule(member.account_id, Number(req.params.id));
  if (!schedule) throw httpError(404, 'Schedule not found');
  accounts.assertStoreAccess(member, schedule.store_id);

  const { force = false, skip = false } = req.body || {};
  res.json(await schedules.runSchedule(member.account_id, schedule.id, { force, markOnly: skip, createdBy: member.id }));
});

/* --------------------------------------------------------- import / export */

router.post('/import/products', async (req, res) => {
  const member = requireMember(req, 'manage_catalog');
  const { csv, default_store_id = null } = req.body || {};
  if (!csv) throw httpError(400, 'No CSV content received');
  res.json(await importProducts(member.account_id, csv, {
    defaultStoreId: default_store_id ? accounts.assertStoreAccess(member, default_store_id) : null,
    allowedStoreIds: member.store_ids,
  }));
});

router.post('/import/counts', async (req, res) => {
  const member = requireMember(req, 'count');
  const { csv, default_store_id = null, counted_at = null } = req.body || {};
  if (!csv) throw httpError(400, 'No CSV content received');
  res.json(await importCounts(member.account_id, csv, {
    defaultStoreId: default_store_id ? accounts.assertStoreAccess(member, default_store_id) : null,
    countedAt: counted_at,
    allowedStoreIds: member.store_ids,
    countedBy: member.id,
  }));
});

router.get('/export/products.csv', async (req, res) => {
  const member = requireMember(req, 'view');
  sendCsv(res, 'products.csv', await exportProductsCsv(member.account_id, {
    storeIds: scopeStores(member, req.query.store_id),
  }));
});

router.get('/export/inventory.csv', async (req, res) => {
  const member = requireMember(req, 'view');
  const storeId = accounts.assertStoreAccess(member, req.query.store_id);
  const store = await db.one('SELECT * FROM stores WHERE id = :id', { id: storeId });

  const rows = await db.all(`
    SELECT p.name AS product_name, p.category, p.base_unit,
           COALESCE(v.name, '') AS supplier_name, COALESCE(ps.sku, '') AS sku,
           COALESCE(sp.on_hand, 0) AS on_hand, COALESCE(sp.par_level, 0) AS par_level,
           COALESCE(sp.reorder_point, 0) AS reorder_point,
           GREATEST(0, COALESCE(sp.par_level, 0) - COALESCE(sp.on_hand, 0)) AS needed,
           (SELECT max(counted_at) FROM counts c WHERE c.store_id = :storeId AND c.product_id = p.id) AS last_counted
    FROM products p
    LEFT JOIN store_products sp ON sp.product_id = p.id AND sp.store_id = :storeId
    LEFT JOIN product_suppliers ps ON ps.product_id = p.id AND ps.is_primary
    LEFT JOIN suppliers v ON v.id = ps.supplier_id
    WHERE p.account_id = :account AND p.active
    ORDER BY p.category, p.name
  `, { storeId, account: member.account_id });

  const columns = ['product_name', 'category', 'base_unit', 'supplier_name', 'sku', 'on_hand', 'par_level', 'reorder_point', 'needed', 'last_counted'];
  sendCsv(res, `inventory-${slug(store.code)}.csv`, toCsv(columns, rows));
});

/** A blank counting sheet to print or fill in on a tablet, then import back. */
router.get('/export/count-sheet.csv', async (req, res) => {
  const member = requireMember(req, 'view');
  const storeId = accounts.assertStoreAccess(member, req.query.store_id);
  const store = await db.one('SELECT * FROM stores WHERE id = :id', { id: storeId });

  const rows = await db.all(`
    SELECT :code AS store_code, p.name AS product_name, COALESCE(ps.sku, '') AS sku,
           p.category, p.base_unit, '' AS qty, COALESCE(sp.on_hand, 0) AS last_on_hand
    FROM products p
    LEFT JOIN store_products sp ON sp.product_id = p.id AND sp.store_id = :storeId
    LEFT JOIN product_suppliers ps ON ps.product_id = p.id AND ps.is_primary
    WHERE p.account_id = :account AND p.active
    ORDER BY p.category, p.name
  `, { storeId, account: member.account_id, code: store.code });

  const columns = ['store_code', 'product_name', 'sku', 'category', 'base_unit', 'qty', 'last_on_hand'];
  sendCsv(res, `count-sheet-${slug(store.code)}.csv`, toCsv(columns, rows));
});

/* --------------------------------------------------------------- dashboard */

router.get('/dashboard', async (req, res) => {
  const member = requireMember(req, 'view');
  const ids = member.store_ids.length ? member.store_ids : [0];

  const stores = await db.all('SELECT * FROM stores WHERE account_id = :account AND id = ANY(:ids) AND active ORDER BY name',
    { account: member.account_id, ids });

  const summary = [];
  for (const store of stores) {
    const stats = await db.one(`
      SELECT count(*)::int AS tracked,
             count(*) FILTER (WHERE par_level > 0 AND on_hand < par_level)::int AS below_par,
             count(*) FILTER (WHERE reorder_point > 0 AND on_hand <= reorder_point)::int AS below_reorder,
             max(updated_at) AS last_update
      FROM store_products WHERE store_id = :store
    `, { store: store.id });

    const value = await db.value(`
      SELECT round(sum(sp.on_hand * (ps.unit_cost / NULLIF(ps.pack_size, 0))), 2)
      FROM store_products sp JOIN product_suppliers ps ON ps.product_id = sp.product_id AND ps.is_primary
      WHERE sp.store_id = :store
    `, { store: store.id });

    const lastCount = await db.value('SELECT max(counted_at) FROM counts WHERE store_id = :store', { store: store.id });
    summary.push({ ...store, ...stats, stock_value: value || 0, last_count: lastCount });
  }

  const openOrders = await db.all(`
    SELECT o.id, o.status, o.created_at, s.name AS store_name, v.name AS supplier_name,
           (SELECT round(sum(oi.qty_packs * oi.unit_cost), 2) FROM order_items oi WHERE oi.order_id = o.id) AS total
    FROM orders o JOIN stores s ON s.id = o.store_id JOIN suppliers v ON v.id = o.supplier_id
    WHERE o.account_id = :account AND o.store_id = ANY(:ids) AND o.status IN ('draft', 'sent')
    ORDER BY o.created_at DESC LIMIT 20
  `, { account: member.account_id, ids });

  const counts = await db.one(`
    SELECT (SELECT count(*)::int FROM products  WHERE account_id = :account AND active) AS products,
           (SELECT count(*)::int FROM suppliers WHERE account_id = :account AND active) AS suppliers,
           (SELECT count(*)::int FROM product_suppliers WHERE account_id = :account)    AS skus,
           (SELECT count(*)::int FROM members   WHERE account_id = :account)            AS people
  `, { account: member.account_id });

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 27 * 86400000).toISOString().slice(0, 10);
  const usage = await usageReport({ accountId: member.account_id, from, to, storeIds: member.store_ids, groupBy: 'total' });
  const upcomingOrders = await schedules.upcoming(member.account_id, 14, { storeIds: member.store_ids });

  res.json({
    account: { id: member.account_id, name: member.account_name },
    stores: summary,
    open_orders: openOrders,
    counts,
    top_usage: usage.rows.slice(0, 10),
    usage_window: { from, to },
    schedule_due: upcomingOrders.filter((u) => u.is_due),
    schedule_upcoming: upcomingOrders.filter((u) => !u.is_due).slice(0, 8),
  });
});

/* ----------------------------------------------------------------- helpers */

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
}

function sendCsv(res, filename, body) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

module.exports = router;
