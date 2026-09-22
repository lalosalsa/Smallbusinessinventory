'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'inventory.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS stores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  code       TEXT NOT NULL UNIQUE,
  address    TEXT DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS suppliers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  contact_name    TEXT DEFAULT '',
  email           TEXT DEFAULT '',
  phone           TEXT DEFAULT '',
  account_number  TEXT DEFAULT '',
  order_days      TEXT DEFAULT '',
  lead_time_days  INTEGER NOT NULL DEFAULT 0,
  min_order_value REAL NOT NULL DEFAULT 0,
  notes           TEXT DEFAULT '',
  active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  category   TEXT DEFAULT '',
  base_unit  TEXT NOT NULL DEFAULT 'each',
  notes      TEXT DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A product can be bought from several suppliers, each with its own SKU/pack/cost.
CREATE TABLE IF NOT EXISTS product_suppliers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  sku         TEXT NOT NULL,
  pack_size   REAL NOT NULL DEFAULT 1,
  pack_unit   TEXT DEFAULT 'case',
  unit_cost   REAL NOT NULL DEFAULT 0,
  is_primary  INTEGER NOT NULL DEFAULT 1,
  UNIQUE (supplier_id, sku),
  UNIQUE (product_id, supplier_id)
);

-- Per-store stock position and par levels.
CREATE TABLE IF NOT EXISTS store_products (
  store_id       INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  par_level      REAL NOT NULL DEFAULT 0,
  reorder_point  REAL NOT NULL DEFAULT 0,
  on_hand        REAL NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (store_id, product_id)
);

-- Physical counts. Usage is derived from the movement between consecutive counts.
CREATE TABLE IF NOT EXISTS counts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id   INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty        REAL NOT NULL,
  counted_at TEXT NOT NULL DEFAULT (datetime('now')),
  note       TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_counts_lookup ON counts (store_id, product_id, counted_at);

-- Product coming in: deliveries against an order, or a one-off receipt/transfer.
CREATE TABLE IF NOT EXISTS receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty         REAL NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  order_id    INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  note        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_receipts_lookup ON receipts (store_id, product_id, received_at);

CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER NOT NULL REFERENCES stores(id)    ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at     TEXT,
  received_at TEXT,
  note        TEXT DEFAULT '',
  schedule_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, created_at);

-- Standing order days: "Sysco, every Monday", "Pacific Paper, 1st of the month".
CREATE TABLE IF NOT EXISTS order_schedules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id     INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  store_id        INTEGER NOT NULL REFERENCES stores(id)    ON DELETE CASCADE,
  name            TEXT DEFAULT '',
  frequency       TEXT NOT NULL DEFAULT 'weekly',   -- weekly | biweekly | monthly | days
  day_of_week     INTEGER,                          -- 0 = Sunday, for weekly/biweekly
  day_of_month    INTEGER,                          -- 1-31, for monthly (clamped to short months)
  interval_days   INTEGER,                          -- for a custom every-N-days cadence
  anchor_date     TEXT NOT NULL,                    -- the cadence counts forward from here
  lead_time_days  INTEGER,                          -- overrides the supplier's lead time
  auto_draft      INTEGER NOT NULL DEFAULT 1,
  mode            TEXT NOT NULL DEFAULT 'both',     -- how quantities are suggested
  days_of_cover   INTEGER NOT NULL DEFAULT 7,
  lookback_days   INTEGER NOT NULL DEFAULT 28,
  last_ordered_on TEXT,                             -- the scheduled date last acted on
  last_order_id   INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  note            TEXT DEFAULT '',
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_schedules_active ON order_schedules (active, supplier_id);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id)    ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  sku        TEXT DEFAULT '',
  pack_size  REAL NOT NULL DEFAULT 1,
  pack_unit  TEXT DEFAULT 'case',
  qty_packs  REAL NOT NULL DEFAULT 0,
  unit_cost  REAL NOT NULL DEFAULT 0,
  UNIQUE (order_id, product_id)
);
`);

// Columns added after the first release, applied in place so an existing database
// upgrades without losing data.
for (const [table, column, definition] of [
  ['orders', 'schedule_id', 'INTEGER'],
]) {
  const present = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Two stores to start with; rename them from the Stores screen.
const storeCount = db.prepare('SELECT COUNT(*) AS n FROM stores').get().n;
if (storeCount === 0) {
  const ins = db.prepare('INSERT INTO stores (name, code) VALUES (?, ?)');
  ins.run('Store 1', 'S1');
  ins.run('Store 2', 'S2');
}

module.exports = { db, DB_PATH };
