# Inventory & Ordering

A small web app for running stock across two (or more) store locations: count what is on
the shelf, keep every product tied to the supplier and SKU you buy it under, see how much
you actually go through each week or month, and turn all of that into order sheets you can
send straight to your suppliers.

Everything runs on your own machine or server. Data lives in one SQLite file — no
accounts, no subscriptions, no cloud.

---

## What it does

- **Two stores side by side.** Every product carries its own par level, reorder point and
  on-hand count per store, so the two locations never get mixed up.
- **Products keyed to supplier SKUs.** One product can come from several suppliers, each
  with its own SKU, case size and price. Order sheets go out with the supplier's SKU on
  every line, which is what they need to fill it.
- **Counting that takes a minute.** One screen, one box per product, Enter to move down
  the list. Works on a phone or tablet while you walk the stockroom.
- **Usage over any period.** Week, month, quarter, year or a custom date range, broken
  down by day, week or month, with the estimated cost of what you used.
- **Order sheets built for you.** Quantities suggested from your pars, from measured
  usage, or whichever is higher — rounded up to whole cases, with a warning when a draft
  is under the supplier's minimum.
- **Standing order days.** "Sysco every Monday", "coffee every second Tuesday", "paper on
  the 1st", or any custom number of days. The app tells you what is due and builds the
  draft.
- **CSV in and out.** Import your product list and count sheets from a spreadsheet; export
  order sheets, stock, count sheets and usage reports back out.

## Quick start

```bash
npm install
npm run seed      # optional: two demo stores, suppliers, products and 8 weeks of history
npm start         # http://localhost:3000
```

To start from an empty book instead, skip `npm run seed`, open **Stores** to name your two
locations, then import your product list from **Import / export**.

```bash
npm test                 # 54 tests covering the usage maths, scheduling, CSV and the API
npm run seed -- --reset  # wipe and reload the demo data
PORT=8080 npm start      # serve on another port
DB_PATH=/srv/inv.db npm start   # keep the database somewhere else
```

---

## The daily rhythm

1. **Count.** *Stock & counts* → pick the store from the top-right chip, type what you
   counted, **Save count**. That writes a dated count and resets on-hand for the store.
2. **Order.** When an order day comes up (*Order schedule*), hit **Build draft**. Adjust
   quantities, save, then **Export CSV for supplier**, **Copy as text** or **Email
   supplier**.
3. **Receive.** When the delivery lands, open the order and hit **Receive delivery**. The
   quantities are added to stock, and they are what tell the app the difference between
   "we used it" and "it never arrived".
4. **Review.** *Usage* shows what you went through this week, this month, or over any
   range you pick.

## How usage is worked out

There is no till integration to set up. Usage comes out of stock movement:

```
usage between two counts = earlier count + everything received in between - later count
```

Each pair of consecutive counts for a product at a store is one segment, and a segment
belongs to the period its closing count falls in — so a Monday-morning count closes the
week that just ended. Two counts of a product is all it takes to get a number; count
weekly and the weekly figures stay honest.

A segment that comes out negative (more on the shelf than could possibly have arrived,
i.e. a miscount or an unrecorded delivery) is treated as zero rather than being allowed to
cancel out real usage elsewhere.

## Order suggestions

For each product a supplier carries, the app works out a target:

| Mode | Target |
| --- | --- |
| Par level | the par you set for that store |
| Measured usage | average daily usage × days of cover |
| Both (default) | whichever of the two is higher |

Then `needed = target − on hand`, converted into the supplier's own pack and **rounded
up** — you cannot order two-thirds of a case. Lines with nothing needed are hidden unless
you ask for them.

## Standing order days

*Order schedule* holds one entry per supplier + store, each repeating:

- **Every week** on a chosen day
- **Every 2 weeks** on a chosen day (the fortnightly rhythm counts forward from the start
  date, so it never drifts)
- **Every month** on a chosen date (short months use their last day — the 31st becomes the
  28th in February)
- **Custom** — any number of days apart

Each schedule remembers how its draft should be built (par/usage/both, days of cover) and
how long the supplier takes to deliver, so the list shows both the order day and the
expected delivery date. When an order day arrives the schedule shows as due; **Build
draft** raises the order, **Skip** moves past it without ordering, and **Build all due
orders** clears everything that is due in one go. A schedule set up with a back-dated
start date sets the rhythm — it does not raise months of missed orders.

Nothing is sent to a supplier automatically. Drafts are raised for you to check, adjust
and send.

---

## CSV formats

Headers are matched loosely: case, spacing, underscores and common synonyms all work, so a
supplier's own price list usually imports as it came. Columns you do not need can be left
out; columns the app does not recognise are reported back and ignored. Sample files are
under `public/samples/` and downloadable from the Import / export screen.

### Products & supplier SKUs

| Column | Also accepted | Meaning |
| --- | --- | --- |
| `product_name` | product, item, item_name, description | **Required.** The name you count by |
| `category` | cat, group, department, type | Dairy, Dry goods, Packaging… |
| `base_unit` | unit, uom, count_unit | What you count in: each, lb, gal |
| `supplier_name` | supplier, vendor, distributor | Created automatically if new |
| `sku` | supplier_sku, item_code, product_code, part_number | The supplier's own code |
| `pack_size` | case_size, units_per_case, pack_qty | Base units per case, e.g. 24 |
| `pack_unit` | order_unit, purchase_unit | case, box, bag… |
| `unit_cost` | cost, price, case_price | Price per case/pack |
| `store_code` | store, location, site | `S1`, `S2` or the store's full name |
| `par_level` | par, target | Target stock at that store |
| `reorder_point` | reorder, min, min_level | Flag the item at or below this |
| `on_hand` | qty, stock, current_qty | Current stock at that store |

One row per product per supplier; add a second row with a different `store_code` to set
pars for the other store. Re-importing the same file updates what is there rather than
duplicating it, and the **product export uses exactly this format**, so you can export,
edit in Excel and import straight back.

### Count sheets

| Column | Also accepted | Meaning |
| --- | --- | --- |
| `store_code` | store, location | Optional if you pick a store on the import screen |
| `sku` | supplier_sku, item_code | Matched first |
| `product_name` | product, item | Used when there is no SKU |
| `qty` | quantity, count, on_hand | **Required.** What you counted |
| `counted_at` | date, count_date | `YYYY-MM-DD`; defaults to the date you pick |
| `note` | notes, comment | Optional |

Rows that match nothing are reported line by line instead of failing the whole import.

### Exports

| Export | Where |
| --- | --- |
| Order sheet for a supplier | the order screen → **Export CSV for supplier** |
| Full product & SKU list | Import / export (round-trips back through the importer) |
| Stock on hand per store | Import / export, or the stock screen |
| Blank count sheet | Import / export, or the stock screen |
| Usage report | the usage screen → **Export CSV** |

---

## How it is put together

```
server.js              Express app: static files + /api
src/db.js              SQLite schema, migrations, two starter stores
src/csv.js             CSV reader/writer with loose header matching
src/usage.js           usage segments, reports, average daily usage
src/orders.js          order suggestions, orders, receiving, supplier CSV
src/schedules.js       standing order days and their date maths
src/importer.js        product and count imports, product export
src/api.js             the HTTP API
public/                the front end: vanilla ES modules, no build step
scripts/seed.js        demo data
test/                  node:test suite
```

No build step and no front-end framework: the browser loads the ES modules directly, so
what you edit is what runs. Dependencies are Express and better-sqlite3.

### API

All endpoints live under `/api` and speak JSON, except the `.csv` ones which return a file.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/dashboard` | Per-store summary, open orders, due order days, top usage |
| GET/POST/PUT/DELETE | `/stores`, `/suppliers`, `/products` | Reference data |
| GET | `/inventory?store_id=&only=below_par` | Stock position for a store |
| POST | `/counts` | Save a counting session |
| POST | `/receipts` | Book stock in outside an order |
| GET | `/usage?from=&to=&group_by=week` | Usage report (also `/usage/export.csv`) |
| POST | `/orders/suggest` | Build a suggested order sheet |
| GET/POST/PUT/DELETE | `/orders`, `/orders/:id` | Orders |
| POST | `/orders/:id/status`, `/orders/:id/receive` | Send / receive an order |
| GET | `/orders/:id/export.csv` | The supplier's copy |
| GET/POST/PUT/DELETE | `/schedules`, `/schedules/:id` | Standing order days |
| GET | `/schedules/upcoming?days=30` | Order-day calendar |
| POST | `/schedules/:id/run` | Build the draft (`force` early, `skip` past it) |
| POST | `/schedules/run-due` | Build every draft that is due |
| POST | `/import/products`, `/import/counts` | CSV import |
| GET | `/export/products.csv`, `/export/inventory.csv`, `/export/count-sheet.csv` | CSV export |

### Backups

Everything is in `data/inventory.db`. Copy that file and you have copied the lot.

```bash
cp data/inventory.db ~/backups/inventory-$(date +%F).db
```

The app is meant for a trusted network — a laptop behind the counter, or a small server on
your own LAN. There is no login, so do not expose it to the open internet as it stands.
