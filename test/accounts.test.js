'use strict';

const { db, resetDatabase, startServer, signUp, signUpOwner, close } = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let app;

before(async () => { await resetDatabase(); app = await startServer(); });
after(async () => { await app.stop(); await close(); });
beforeEach(async () => { await db.run('TRUNCATE accounts, local_users CASCADE'); });

/** Invites someone, signs them up, and returns a client for them. */
async function addPerson(owner, { email, role, all_locations = false, store_ids = [] }) {
  const invited = await owner.as('/api/members/invite', {
    method: 'POST', body: { email, role, all_locations, store_ids },
  });
  assert.equal(invited.status, 201, JSON.stringify(invited.payload));
  const person = await signUp(app.call, { email, display_name: email.split('@')[0] });
  const me = (await person.as('/api/auth/me')).payload;
  return { ...person, me };
}

test('registering needs an email and a password worth the name', async () => {
  assert.equal((await app.call('/api/auth/register', { method: 'POST', body: { email: 'a@b.com', password: 'short' } })).status, 400);
  assert.equal((await app.call('/api/auth/register', { method: 'POST', body: { password: 'password123' } })).status, 400);

  const first = await app.call('/api/auth/register', { method: 'POST', body: { email: 'dup@example.com', password: 'password123' } });
  assert.equal(first.status, 201);
  const second = await app.call('/api/auth/register', { method: 'POST', body: { email: 'DUP@example.com', password: 'password123' } });
  assert.equal(second.status, 400);
  assert.match(second.payload.error, /sign in instead/);
});

test('signing in returns a token that identifies the user', async () => {
  await app.call('/api/auth/register', { method: 'POST', body: { email: 'sign@example.com', password: 'password123' } });
  assert.equal((await app.call('/api/auth/login', { method: 'POST', body: { email: 'sign@example.com', password: 'nope12345' } })).status, 401);

  const { status, payload } = await app.call('/api/auth/login', { method: 'POST', body: { email: 'sign@example.com', password: 'password123' } });
  assert.equal(status, 200);
  const me = (await app.call('/api/auth/me', { token: payload.token })).payload;
  assert.equal(me.user.email, 'sign@example.com');
  assert.equal(me.member, null, 'no account until one is created or an invite is accepted');
});

test('a signed-in user without an account can create one, but only one', async () => {
  const user = await signUp(app.call, { email: 'new@example.com' });
  assert.equal((await user.as('/api/products')).status, 403);

  const created = await user.as('/api/accounts', { method: 'POST', body: { name: 'Corner Shop', locations: ['Main St', 'Beach Rd'] } });
  assert.equal(created.status, 201);
  assert.equal(created.payload.role, 'owner');

  const stores = (await user.as('/api/stores')).payload;
  assert.deepEqual(stores.map((s) => s.name), ['Beach Rd', 'Main St']);
  assert.deepEqual(stores.map((s) => s.code).sort(), ['BEAC', 'MAIN']);

  const again = await user.as('/api/accounts', { method: 'POST', body: { name: 'Second Shop' } });
  assert.equal(again.status, 400);
});

test('an invited person joins with the role and locations they were given', async () => {
  const owner = await signUpOwner(app.call, { email: 'owner@example.com' });
  const downtown = owner.stores.find((s) => s.name === 'Downtown');

  const staff = await addPerson(owner, { email: 'staff@example.com', role: 'staff', store_ids: [downtown.id] });
  assert.equal(staff.me.member.role, 'staff');
  assert.equal(staff.me.member.account_name, 'Test Cafe');
  assert.deepEqual(staff.me.member.store_ids, [downtown.id]);
  assert.deepEqual(staff.me.stores.map((s) => s.name), ['Downtown']);

  const listed = (await owner.as('/api/members')).payload;
  assert.equal(listed.members.length, 2);
  assert.equal(listed.invites.length, 0, 'the invitation is used up once accepted');
});

test('staff can count their location but cannot change the catalogue or order', async () => {
  const owner = await signUpOwner(app.call, { email: 'owner2@example.com' });
  const downtown = owner.stores.find((s) => s.name === 'Downtown');
  const riverside = owner.stores.find((s) => s.name === 'Riverside');
  await owner.as('/api/import/products', {
    method: 'POST',
    body: { csv: 'product_name,supplier_name,sku,pack_size,unit_cost\nMilk,Sysco,SY-1,4,20\n' },
  });
  const milk = (await owner.as('/api/products')).payload[0];
  const sysco = (await owner.as('/api/suppliers')).payload[0];

  const staff = await addPerson(owner, { email: 'counter@example.com', role: 'staff', store_ids: [downtown.id] });

  const counted = await staff.as('/api/counts', { method: 'POST', body: { store_id: downtown.id, lines: [{ product_id: milk.id, qty: 4 }] } });
  assert.equal(counted.status, 201);
  assert.equal((await staff.as(`/api/inventory?store_id=${downtown.id}`)).payload.length, 1);

  // The other location is out of reach entirely.
  assert.equal((await staff.as(`/api/inventory?store_id=${riverside.id}`)).status, 403);
  assert.equal((await staff.as('/api/counts', { method: 'POST', body: { store_id: riverside.id, lines: [{ product_id: milk.id, qty: 1 }] } })).status, 403);

  // And ordering or editing the catalogue is not theirs to do.
  assert.equal((await staff.as('/api/products', { method: 'POST', body: { name: 'Sneaky' } })).status, 403);
  assert.equal((await staff.as('/api/suppliers', { method: 'POST', body: { name: 'Sneaky Co' } })).status, 403);
  assert.equal((await staff.as('/api/orders/suggest', { method: 'POST', body: { store_id: downtown.id, supplier_id: sysco.id } })).status, 403);
  assert.equal((await staff.as('/api/members/invite', { method: 'POST', body: { email: 'x@y.com', role: 'owner', all_locations: true } })).status, 403);
  assert.equal((await staff.as('/api/stores', { method: 'POST', body: { name: 'New Shop', code: 'NEW' } })).status, 403);
});

test('a manager runs the catalogue and orders, but not the people', async () => {
  const owner = await signUpOwner(app.call, { email: 'owner3@example.com' });
  const downtown = owner.stores.find((s) => s.name === 'Downtown');
  const manager = await addPerson(owner, { email: 'manager@example.com', role: 'manager', store_ids: [downtown.id] });

  assert.equal((await manager.as('/api/suppliers', { method: 'POST', body: { name: 'Bay Roasters', min_order_value: 100 } })).status, 201);
  assert.equal((await manager.as('/api/products', { method: 'POST', body: { name: 'Beans', base_unit: 'lb' } })).status, 201);

  const supplier = (await manager.as('/api/suppliers')).payload[0];
  assert.equal((await manager.as('/api/orders/suggest', { method: 'POST', body: { store_id: downtown.id, supplier_id: supplier.id } })).status, 200);
  assert.equal((await manager.as('/api/members/invite', { method: 'POST', body: { email: 'x@y.com', role: 'staff', store_ids: [downtown.id] } })).status, 403);
  assert.equal((await manager.as('/api/stores/' + downtown.id, { method: 'DELETE' })).status, 403);
});

test('an all-locations member follows the account as new locations are added', async () => {
  const owner = await signUpOwner(app.call, { email: 'owner4@example.com' });
  const manager = await addPerson(owner, { email: 'everywhere@example.com', role: 'manager', all_locations: true });
  assert.equal(manager.me.member.store_ids.length, 2);

  await owner.as('/api/stores', { method: 'POST', body: { name: 'Airport', code: 'AIR' } });
  const refreshed = (await manager.as('/api/auth/me')).payload;
  assert.equal(refreshed.member.store_ids.length, 3);
  assert.ok(refreshed.stores.some((s) => s.name === 'Airport'));
});

test('an owner can change a person\'s role and locations, and remove them', async () => {
  const owner = await signUpOwner(app.call, { email: 'owner5@example.com' });
  const [downtown, riverside] = owner.stores;
  const staff = await addPerson(owner, { email: 'promote@example.com', role: 'staff', store_ids: [downtown.id] });

  await owner.as(`/api/members/${staff.me.member.id}`, {
    method: 'PUT', body: { role: 'manager', store_ids: [downtown.id, riverside.id] },
  });
  const after = (await staff.as('/api/auth/me')).payload;
  assert.equal(after.member.role, 'manager');
  assert.equal(after.member.store_ids.length, 2);

  assert.equal((await owner.as(`/api/members/${staff.me.member.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await staff.as('/api/products')).status, 403, 'they lose access as soon as they are removed');
});

test('an account cannot be left without an owner', async () => {
  const owner = await signUpOwner(app.call, { email: 'owner6@example.com' });
  const me = (await owner.as('/api/auth/me')).payload.member;
  assert.equal((await owner.as(`/api/members/${me.id}`, { method: 'DELETE' })).status, 400);
  const demoted = await owner.as(`/api/members/${me.id}`, { method: 'PUT', body: { role: 'manager' } });
  assert.equal(demoted.status, 400);
  assert.match(demoted.payload.error, /at least one owner/);
});

test('an invitation needs a location unless it covers all of them', async () => {
  const owner = await signUpOwner(app.call, { email: 'owner7@example.com' });
  const bad = await owner.as('/api/members/invite', { method: 'POST', body: { email: 'nowhere@example.com', role: 'staff' } });
  assert.equal(bad.status, 400);
  assert.match(bad.payload.error, /at least one location/);

  assert.equal((await owner.as('/api/members/invite', { method: 'POST', body: { email: 'not-an-email', role: 'staff', all_locations: true } })).status, 400);
  assert.equal((await owner.as('/api/members/invite', { method: 'POST', body: { email: 'ok@example.com', role: 'chief', all_locations: true } })).status, 400);

  const good = await owner.as('/api/members/invite', { method: 'POST', body: { email: 'ok@example.com', role: 'staff', all_locations: true } });
  assert.equal(good.status, 201);
  assert.equal((await owner.as('/api/members')).payload.invites.length, 1);

  await owner.as(`/api/invites/${good.payload.id}`, { method: 'DELETE' });
  assert.equal((await owner.as('/api/members')).payload.invites.length, 0);
});

test('two businesses on the same database never see each other', async () => {
  const cafe = await signUpOwner(app.call, { email: 'cafe@example.com', accountName: 'Cafe', locations: ['Cafe Main'] });
  const deli = await signUpOwner(app.call, { email: 'deli@example.com', accountName: 'Deli', locations: ['Deli Main'] });

  await cafe.as('/api/import/products', { method: 'POST', body: { csv: 'product_name,supplier_name,sku\nCafe Milk,Sysco,C-1\n' } });
  await deli.as('/api/import/products', { method: 'POST', body: { csv: 'product_name,supplier_name,sku\nDeli Ham,Local Farm,D-1\n' } });

  assert.deepEqual((await cafe.as('/api/products')).payload.map((p) => p.name), ['Cafe Milk']);
  assert.deepEqual((await deli.as('/api/products')).payload.map((p) => p.name), ['Deli Ham']);
  assert.deepEqual((await cafe.as('/api/suppliers')).payload.map((s) => s.name), ['Sysco']);

  // The deli owner cannot reach into the cafe's location even by guessing its id.
  const cafeStore = cafe.stores[0];
  assert.equal((await deli.as(`/api/inventory?store_id=${cafeStore.id}`)).status, 403);
  assert.equal((await deli.as(`/api/export/count-sheet.csv?store_id=${cafeStore.id}`)).status, 403);
});

test('a bad or expired token is treated as signed out', async () => {
  assert.equal((await app.call('/api/products', { token: 'not-a-real-token' })).status, 401);
  assert.equal((await app.call('/api/auth/me', { token: 'nonsense.signature' })).payload.user, null);
});
