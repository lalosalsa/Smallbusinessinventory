-- Inventory & Ordering: Postgres schema (Supabase-ready).
--
-- Safe to run more than once. Every business table hangs off an account, so one
-- Supabase project can host several businesses without their data ever meeting.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

/* ------------------------------------------------------------ account layer */

CREATE TABLE IF NOT EXISTS accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per person on an account. user_id is the Supabase auth.users id
-- (or the local user id when the app runs without Supabase).
CREATE TABLE IF NOT EXISTS members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL,
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'manager', 'staff')),
  all_locations BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON members (user_id);

/* ---------------------------------------------------------------- locations */

CREATE TABLE IF NOT EXISTS stores (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  code       TEXT NOT NULL,
  address    TEXT NOT NULL DEFAULT '',
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, code),
  UNIQUE (account_id, name)
);

-- Which locations a member may work in. Ignored when the member has all_locations.
CREATE TABLE IF NOT EXISTS member_locations (
  member_id UUID   NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  store_id  BIGINT NOT NULL REFERENCES stores(id)  ON DELETE CASCADE,
  PRIMARY KEY (member_id, store_id)
);

-- Pending invitations. A person who signs in with an invited email joins the
-- account with the role and locations that were set for them.
CREATE TABLE IF NOT EXISTS invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'manager', 'staff')),
  all_locations BOOLEAN NOT NULL DEFAULT false,
  store_ids     BIGINT[] NOT NULL DEFAULT '{}',
  token         TEXT NOT NULL UNIQUE,
  invited_by    UUID REFERENCES members(id) ON DELETE SET NULL,
  accepted_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, email)
);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites (lower(email));

/* ------------------------------------------------------- catalogue & stock */

CREATE TABLE IF NOT EXISTS suppliers (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  contact_name    TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  account_number  TEXT NOT NULL DEFAULT '',
  order_days      TEXT NOT NULL DEFAULT '',
  lead_time_days  INTEGER NOT NULL DEFAULT 0,
  min_order_value NUMERIC NOT NULL DEFAULT 0,
  notes           TEXT NOT NULL DEFAULT '',
  active          BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS products (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT '',
  base_unit  TEXT NOT NULL DEFAULT 'each',
  notes      TEXT NOT NULL DEFAULT '',
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);

-- A product can be bought from several suppliers, each with its own SKU and pack.
CREATE TABLE IF NOT EXISTS product_suppliers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  UUID   NOT NULL REFERENCES accounts(id)  ON DELETE CASCADE,
  product_id  BIGINT NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  sku         TEXT   NOT NULL,
  pack_size   NUMERIC NOT NULL DEFAULT 1,
  pack_unit   TEXT    NOT NULL DEFAULT 'case',
  unit_cost   NUMERIC NOT NULL DEFAULT 0,
  is_primary  BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (supplier_id, sku),
  UNIQUE (product_id, supplier_id)
);

CREATE TABLE IF NOT EXISTS store_products (
  account_id    UUID    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id      BIGINT  NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
  product_id    BIGINT  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  par_level     NUMERIC NOT NULL DEFAULT 0,
  reorder_point NUMERIC NOT NULL DEFAULT 0,
  on_hand       NUMERIC NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_id)
);

-- Physical counts. Usage is derived from the movement between consecutive counts.
CREATE TABLE IF NOT EXISTS counts (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id UUID    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id   BIGINT  NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
  product_id BIGINT  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty        NUMERIC NOT NULL,
  counted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  counted_by UUID REFERENCES members(id) ON DELETE SET NULL,
  note       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_counts_lookup ON counts (store_id, product_id, counted_at);

CREATE TABLE IF NOT EXISTS orders (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  UUID   NOT NULL REFERENCES accounts(id)  ON DELETE CASCADE,
  store_id    BIGINT NOT NULL REFERENCES stores(id)    ON DELETE CASCADE,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES members(id) ON DELETE SET NULL,
  sent_at     TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  schedule_id BIGINT,
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (account_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   BIGINT  NOT NULL REFERENCES orders(id)   ON DELETE CASCADE,
  product_id BIGINT  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku        TEXT    NOT NULL DEFAULT '',
  pack_size  NUMERIC NOT NULL DEFAULT 1,
  pack_unit  TEXT    NOT NULL DEFAULT 'case',
  qty_packs  NUMERIC NOT NULL DEFAULT 0,
  unit_cost  NUMERIC NOT NULL DEFAULT 0,
  UNIQUE (order_id, product_id)
);

-- Product coming in: a delivery against an order, or a one-off buy or transfer.
CREATE TABLE IF NOT EXISTS receipts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  UUID    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id    BIGINT  NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
  product_id  BIGINT  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty         NUMERIC NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  order_id    BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_receipts_lookup ON receipts (store_id, product_id, received_at);

-- Standing order days: "Sysco every Monday", "paper on the 1st".
CREATE TABLE IF NOT EXISTS order_schedules (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      UUID   NOT NULL REFERENCES accounts(id)  ON DELETE CASCADE,
  supplier_id     BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  store_id        BIGINT NOT NULL REFERENCES stores(id)    ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT '',
  frequency       TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('weekly', 'biweekly', 'monthly', 'days')),
  day_of_week     INTEGER,
  day_of_month    INTEGER,
  interval_days   INTEGER,
  anchor_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  lead_time_days  INTEGER,
  auto_draft      BOOLEAN NOT NULL DEFAULT true,
  mode            TEXT NOT NULL DEFAULT 'both',
  days_of_cover   INTEGER NOT NULL DEFAULT 7,
  lookback_days   INTEGER NOT NULL DEFAULT 28,
  last_ordered_on DATE,
  last_order_id   BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  note            TEXT NOT NULL DEFAULT '',
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_schedules_active ON order_schedules (account_id, active);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_schedule_id_fkey;
ALTER TABLE orders ADD CONSTRAINT orders_schedule_id_fkey
  FOREIGN KEY (schedule_id) REFERENCES order_schedules(id) ON DELETE SET NULL;

/* ----------------------------------------------------- local sign-in (only) */

-- Used when the app runs without Supabase (AUTH_MODE=local). With Supabase Auth
-- this table stays empty and auth.users is the source of truth.
CREATE TABLE IF NOT EXISTS local_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
