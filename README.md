# Inventory & Ordering

A web app for running stock across all of your locations: count what is on the shelf, keep
every product tied to the supplier and SKU you buy it under, see how much you actually go
through each week or month, and turn all of that into order sheets you can send straight
to your suppliers.

One account covers the whole business. Add your locations, invite the people who work
there, and give each of them the access they need — nothing more.

Data lives in **Postgres**, which means a [Supabase](https://supabase.com) project works
out of the box.

---

## What it does

- **As many locations as you like.** Every product carries its own par level, reorder point
  and on-hand count per location, so nothing gets mixed up between them.
- **People join with a code.** An owner creates a join code — `BREW-4K7Q` — carrying a
  role and a set of locations. Whoever types it is in. Owners run the account; managers
  run the catalogue and the ordering; staff count stock. Each person sees only the
  locations their code gave them.
- **Products keyed to supplier SKUs.** One product can come from several suppliers, each
  with its own SKU, case size and price. Order sheets go out with the supplier's SKU on
  every line, which is what they need to fill it.
- **Counting that takes a minute.** One screen, one box per product, Enter to move down
  the list. Works on a phone or tablet while you walk the stockroom.
- **Usage over any period.** Week, month, quarter, year or a custom range, broken down by
  day, week or month, with the estimated cost of what you used.
- **Order sheets built for you.** Quantities suggested from your pars, from measured
  usage, or whichever is higher — rounded up to whole cases, with a warning when a draft
  is under the supplier's minimum.
- **Standing order days.** "Sysco every Monday", "coffee every second Tuesday", "paper on
  the 1st", or any custom number of days. The app tells you what is due and builds the
  draft.
- **CSV in and out.** Import your product list and count sheets from a spreadsheet; export
  order sheets per supplier, stock, count sheets and usage reports back out.

## Quick start

```bash
npm install
cp .env.example .env     # put your Supabase connection string in it
npm start                # http://localhost:3000
```

The tables are created on first boot. Open the app, create your sign-in, name the business
and its locations, and you are running.

Want something to look at first?

```bash
npm run seed             # a demo account with 8 weeks of counts, orders and schedules
                         # signs in as owner@example.com / password123
```

`docs/supabase-setup.md` walks through getting the connection string out of the Supabase
dashboard. Only `DATABASE_URL` is needed — sign-in works out of the box.

```bash
npm test                 # 67 tests, run against a real Postgres
npm run seed -- --reset  # wipe every account and reload the demo data
PORT=8080 npm start      # serve on another port
```

### Sign-in

**Nobody ever waits on an email to get in.** By default the app handles sign-in itself: a
new person types an email and a password and is straight into the app. No confirmation
email, no verification code, no magic link. An invited person does exactly the same, with
the address they were invited at, and lands on your account with their role and locations
already set.

If you would rather Supabase handled sign-in (for its password-reset emails, say), set
`AUTH_MODE=supabase` along with `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Do turn **Confirm
email** off first — Supabase dashboard → Authentication → Sign In / Providers → Email —
or new people will be made to click an emailed link before they can sign in. If you leave
it on, the app says so plainly instead of leaving anyone stuck.

Either way, the app's own `members` table decides who may do what.

---

## Who can do what

| | Owner | Manager | Staff |
| --- | --- | --- | --- |
| Count stock, import count sheets | ✓ | ✓ | ✓ |
| See stock, usage and reports | ✓ | ✓ | ✓ |
| Products, suppliers, pars, SKUs | ✓ | ✓ | |
| Build, send and receive orders | ✓ | ✓ | |
| Standing order days | ✓ | ✓ | |
| Create join codes, set roles | ✓ | | |
| Add and remove locations | ✓ | | |

Managers and staff see only the locations assigned to them — a barista at one shop cannot
count, or even see, the stock at the other. Tick **every location** instead and that person
follows the account as new locations are added. Owners always reach everything, and an
account can never be left without one.

### Getting someone in

**People → Create join code.** Choose the role and locations it grants, then hand the code
over however you like — text it, write it on the whiteboard, read it down the phone. They
sign up at the same web address, type it, and they are in. Nothing is emailed, and there is
no link to click.

A code can be:

- **capped** — one use for a single hire, five for a new shift, or unlimited
- **time-limited** — expires after a number of days
- **reserved** — tied to one email address, so only that person can use it
- **turned off** — at any point, without disturbing anyone who already joined

Used and turned-off codes stay listed under People so you can see who came in on what.
A code tied to an email is applied automatically the first time that person signs in, so
they need not type anything at all.

## The daily rhythm

1. **Sign in.** Everyone uses the same web address. New people either start a business or
   type the join code they were given.
2. **Count.** *Stock & counts* → pick the location from the top-right chip, type what you
   counted, **Save count**. That writes a dated count and resets on-hand for that location.
3. **Order.** When an order day comes up (*Order schedule*), hit **Build draft**. Adjust
   quantities, save, then **Export CSV for supplier**, **Copy as text** or **Email
   supplier**.
4. **Receive.** When the delivery lands, open the order and hit **Receive delivery**. The
   quantities are added to stock, and they are what tell the app the difference between
   "we used it" and "it never arrived".
5. **Review.** *Usage* shows what you went through this week, this month, or over any
   range you pick.

## How usage is worked out

There is no till integration to set up. Usage comes out of stock movement:

```
usage between two counts = earlier count + everything received in between - later count
```

Each pair of consecutive counts for a product at a location is one segment, and a segment
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
| Par level | the par you set for that location |
| Measured usage | average daily usage × days of cover |
| Both (default) | whichever of the two is higher |

Then `needed = target − on hand`, converted into the supplier's own pack and **rounded
up** — you cannot order two-thirds of a case. Lines with nothing needed are hidden unless
you ask for them.

## Standing order days

*Order schedule* holds one entry per supplier + location, each repeating:

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
| `store_code` | store, location, site | The location's short code, or its full name |
| `par_level` | par, target | Target stock at that location |
| `reorder_point` | reorder, min, min_level | Flag the item at or below this |
| `on_hand` | qty, stock, current_qty | Current stock at that location |

One row per product per supplier; add a second row with a different `store_code` to set
pars for another location. Re-importing the same file updates what is there rather than
duplicating it, and the **product export uses exactly this format**, so you can export,
edit in Excel and import straight back.

### Count sheets

| Column | Also accepted | Meaning |
| --- | --- | --- |
| `store_code` | store, location | Optional if you pick a location on the import screen |
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
| Order sheet before saving an order | the order builder → **Export CSV now** |
| Full product & SKU list | Import / export (round-trips back through the importer) |
| Stock on hand per location | Import / export, or the stock screen |
| Blank count sheet | Import / export, or the stock screen |
| Usage report | the usage screen → **Export CSV** |

---

## How it is put together

```
server.js              Express app: static files + /api, migrations on boot
sql/schema.sql         the whole Postgres schema, safe to re-run
src/db.js              Postgres pool, :named parameters, transactions
src/auth.js            Supabase Auth or local email/password sign-in
src/accounts.js        accounts, members, invitations, roles, location access
src/csv.js             CSV reader/writer with loose header matching
src/usage.js           usage segments, reports, average daily usage
src/orders.js          order suggestions, orders, receiving, supplier CSV
src/schedules.js       standing order days and their date maths
src/importer.js        product and count imports, product export
src/api.js             the HTTP API, with the permission checks
public/                the front end: vanilla ES modules, no build step
scripts/seed.js        demo account
test/                  node:test suite, run against a real Postgres
```

No build step and no front-end framework: the browser loads the ES modules directly, so
what you edit is what runs.

### Environment

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | **Required.** Postgres/Supabase connection string |
| `AUTH_MODE=supabase` | Sign in with Supabase Auth instead of the app's own (needs the two below) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Your Supabase project's URL and anon key |
| `PORT`, `HOST` | Where to listen (default `3000`, `0.0.0.0`) |
| `SKIP_MIGRATE=1` | Do not apply `sql/schema.sql` at boot |
| `PGSSL=disable` | For a plain local Postgres |
| `AUTH_SECRET` | Signs local-mode tokens; generated and saved if unset |

### Tests

```bash
createdb inv_test
TEST_DATABASE_URL=postgres://localhost/inv_test npm test
```

They run against a real database rather than a stand-in, so the SQL that ships is the SQL
that was tested. `test/accounts.test.js` is the one to keep an eye on: it holds the account
and location boundaries in place.

### API

All endpoints live under `/api`, speak JSON, and expect `Authorization: Bearer <token>`
except the sign-in ones. Everything is scoped to the signed-in person's account.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/auth/config` | Which sign-in mode the server is in |
| POST | `/auth/register`, `/auth/login` | Local-mode sign-in |
| GET | `/auth/me` | Who am I, my role, my locations |
| POST | `/accounts` | Create the business (first run) |
| GET/PUT/DELETE | `/members`, `/members/:id` | People on the account |
| POST | `/members/invite` | Create a join code |
| POST/DELETE | `/invites/:id/revoke`, `/invites/:id` | Turn a code off, or delete it |
| GET | `/join/:code` | What a code is for, before using it |
| POST | `/join` | Join the account a code belongs to |
| GET/POST/PUT/DELETE | `/stores`, `/suppliers`, `/products` | Locations and catalogue |
| GET | `/inventory?store_id=&only=below_par` | Stock position for a location |
| POST | `/counts`, `/receipts` | Save a count; book stock in |
| GET | `/usage?from=&to=&group_by=week` | Usage report (also `/usage/export.csv`) |
| POST | `/orders/suggest` | Build a suggested order sheet |
| GET | `/orders/sheet.csv?store_id=&supplier_id=` | That sheet as supplier CSV, unsaved |
| GET/POST/PUT/DELETE | `/orders`, `/orders/:id` | Orders |
| POST | `/orders/:id/status`, `/orders/:id/receive` | Send / receive an order |
| GET | `/orders/:id/export.csv` | The supplier's copy |
| GET/POST/PUT/DELETE | `/schedules`, `/schedules/:id` | Standing order days |
| GET | `/schedules/upcoming?days=30` | Order-day calendar |
| POST | `/schedules/:id/run`, `/schedules/run-due` | Build drafts that are due |
| POST | `/import/products`, `/import/counts` | CSV import |
| GET | `/export/products.csv`, `/export/inventory.csv`, `/export/count-sheet.csv` | CSV export |
