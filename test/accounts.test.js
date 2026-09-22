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
  return { ...person, me, code: invited.payload.code };
}

/** Creates an open join code and returns it. */
async function makeCode(owner, body) {
  const created = await owner.as('/api/members/invite', { method: 'POST', body });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  return created.payload;
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
  assert.equal(listed.invites[0].status, 'spent', 'the code is used up once accepted');
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

test('a join code needs a location unless it covers all of them', async () => {
  const owner = await signUpOwner(app.call, { email: 'owner7@example.com' });
  const bad = await owner.as('/api/members/invite', { method: 'POST', body: { role: 'staff' } });
  assert.equal(bad.status, 400);
  assert.match(bad.payload.error, /at least one location/);

  assert.equal((await owner.as('/api/members/invite', { method: 'POST', body: { email: 'not-an-email', role: 'staff', all_locations: true } })).status, 400);
  assert.equal((await owner.as('/api/members/invite', { method: 'POST', body: { role: 'chief', all_locations: true } })).status, 400);
  assert.equal((await owner.as('/api/members/invite', { method: 'POST', body: { role: 'staff', all_locations: true, max_uses: 0 } })).status, 400);

  const good = await makeCode(owner, { role: 'staff', all_locations: true });
  assert.equal((await owner.as('/api/members')).payload.invites.length, 1);

  await owner.as(`/api/invites/${good.id}`, { method: 'DELETE' });
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

test('signing up gets you straight in: no code, no link, no waiting', async () => {
  const registered = await app.call('/api/auth/register', {
    method: 'POST', body: { email: 'straight-in@example.com', password: 'password123' },
  });
  assert.equal(registered.status, 201);
  assert.ok(registered.payload.token, 'the token comes back with the sign-up itself');

  // That token works immediately — nothing to confirm first.
  const me = (await app.call('/api/auth/me', { token: registered.payload.token })).payload;
  assert.equal(me.user.email, 'straight-in@example.com');
  assert.equal(me.mode, 'local');

  const created = await app.call('/api/accounts', {
    token: registered.payload.token,
    method: 'POST',
    body: { name: 'Straight In Co', locations: ['Only Shop'] },
  });
  assert.equal(created.status, 201, 'and the account can be set up in the same sitting');
});

test('an invited person joins by signing up, with no invite code to enter', async () => {
  const owner = await signUpOwner(app.call, { email: 'owner8@example.com' });
  const store = owner.stores[0];
  await owner.as('/api/members/invite', {
    method: 'POST', body: { email: 'newhire@example.com', role: 'staff', store_ids: [store.id] },
  });

  // The invited person needs nothing but the email address and a password.
  const hire = await signUp(app.call, { email: 'newhire@example.com' });
  const me = (await hire.as('/api/auth/me')).payload;
  assert.equal(me.member.role, 'staff');
  assert.equal(me.member.account_name, 'Test Cafe');
  assert.deepEqual(me.member.store_ids, [store.id]);
});

test('sign-in stays in local mode unless AUTH_MODE asks for Supabase', async () => {
  const { payload } = await app.call('/api/auth/config');
  assert.equal(payload.mode, 'local');
  assert.equal(payload.supabase_url, undefined, 'nothing about Supabase leaks into the sign-in config');
});

test('locations whose names share a prefix still get distinct codes', async () => {
  const user = await signUp(app.call, { email: 'prefix@example.com' });
  const created = await user.as('/api/accounts', {
    method: 'POST',
    body: { name: 'Prefix Co', locations: ['Store 1', 'Store 2', 'Store 3', 'Storeroom'] },
  });
  assert.equal(created.status, 201);

  const codes = (await user.as('/api/stores')).payload.map((s) => s.code);
  assert.equal(codes.length, 4);
  assert.equal(new Set(codes).size, 4, `codes must be unique, got ${codes.join(', ')}`);
});

test('the default two locations from the setup screen do not collide', async () => {
  const user = await signUp(app.call, { email: 'defaults@example.com' });
  const created = await user.as('/api/accounts', { method: 'POST', body: { name: 'Defaults Co' } });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const codes = (await user.as('/api/stores')).payload.map((s) => s.code);
  assert.deepEqual(new Set(codes).size, codes.length);
});

test('a duplicate location name is refused in words, not with a 500', async () => {
  const owner = await signUpOwner(app.call, { email: 'owner9@example.com' });
  const clash = await owner.as('/api/stores', { method: 'POST', body: { name: 'Downtown', code: 'DT2' } });
  assert.equal(clash.status, 400);
  assert.match(clash.payload.error, /already used/);

  const codeClash = await owner.as('/api/stores', { method: 'POST', body: { name: 'Somewhere else', code: 'DOWN' } });
  assert.equal(codeClash.status, 400);
});

/* --------------------------------------------------------------- join codes */

test('a join code is short, readable, and carries the role and locations', async () => {
  const owner = await signUpOwner(app.call, { email: 'codes1@example.com', accountName: 'Brew Co' });
  const downtown = owner.stores[0];

  const code = await makeCode(owner, { role: 'staff', store_ids: [downtown.id], label: 'Weekend baristas' });
  assert.match(code.code, /^BREW-[A-Z2-9]{4}$/, `unexpected code ${code.code}`);
  assert.equal(code.label, 'Weekend baristas');
  assert.equal(code.uses, 0);
  assert.equal(code.max_uses, 1);

  // Anyone can look up what a code is for before committing to it.
  const described = (await app.call(`/api/join/${code.code}`)).payload;
  assert.equal(described.account_name, 'Brew Co');
  assert.equal(described.role, 'staff');
  assert.deepEqual(described.locations, [downtown.name]);
});

test('someone joins the business by typing the code', async () => {
  const owner = await signUpOwner(app.call, { email: 'codes2@example.com' });
  const downtown = owner.stores[0];
  const code = await makeCode(owner, { role: 'manager', store_ids: [downtown.id] });

  const hire = await signUp(app.call, { email: 'hire@example.com', display_name: 'Alex' });
  assert.equal((await hire.as('/api/auth/me')).payload.member, null);

  const joined = await hire.as('/api/join', { method: 'POST', body: { code: code.code } });
  assert.equal(joined.status, 201);

  const me = (await hire.as('/api/auth/me')).payload;
  assert.equal(me.member.role, 'manager');
  assert.equal(me.member.account_name, 'Test Cafe');
  assert.deepEqual(me.member.store_ids, [downtown.id]);
  assert.deepEqual(me.stores.map((s) => s.name), [downtown.name]);

  // And the owner sees them, with the code marked as used up.
  const people = (await owner.as('/api/members')).payload;
  assert.equal(people.members.length, 2);
  assert.equal(people.invites[0].uses, 1);
  assert.equal(people.invites[0].status, 'spent');
});

test('codes are case and whitespace forgiving, because people retype them', async () => {
  const owner = await signUpOwner(app.call, { email: 'codes3@example.com' });
  const code = await makeCode(owner, { role: 'staff', all_locations: true });

  const hire = await signUp(app.call, { email: 'sloppy@example.com' });
  const joined = await hire.as('/api/join', { method: 'POST', body: { code: `  ${code.code.toLowerCase()} ` } });
  assert.equal(joined.status, 201);
  assert.equal((await hire.as('/api/auth/me')).payload.member.role, 'staff');
});

test('a single-use code cannot be passed around', async () => {
  const owner = await signUpOwner(app.call, { email: 'codes4@example.com' });
  const code = await makeCode(owner, { role: 'staff', all_locations: true, max_uses: 1 });

  const first = await signUp(app.call, { email: 'first@example.com' });
  assert.equal((await first.as('/api/join', { method: 'POST', body: { code: code.code } })).status, 201);

  const second = await signUp(app.call, { email: 'second@example.com' });
  const refused = await second.as('/api/join', { method: 'POST', body: { code: code.code } });
  assert.equal(refused.status, 400);
  assert.match(refused.payload.error, /already been used up/);
});

test('a code can be good for a whole shift of people', async () => {
  const owner = await signUpOwner(app.call, { email: 'codes5@example.com' });
  const code = await makeCode(owner, { role: 'staff', all_locations: true, max_uses: 3 });

  for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
    const person = await signUp(app.call, { email });
    assert.equal((await person.as('/api/join', { method: 'POST', body: { code: code.code } })).status, 201);
  }

  const fourth = await signUp(app.call, { email: 'd@example.com' });
  assert.equal((await fourth.as('/api/join', { method: 'POST', body: { code: code.code } })).status, 400);
  assert.equal((await owner.as('/api/members')).payload.members.length, 4);
});

test('an unlimited code keeps working', async () => {
  const owner = await signUpOwner(app.call, { email: 'codes6@example.com' });
  const code = await makeCode(owner, { role: 'staff', all_locations: true, max_uses: null });
  assert.equal(code.max_uses, null);

  for (const email of ['e@example.com', 'f@example.com']) {
    const person = await signUp(app.call, { email });
    assert.equal((await person.as('/api/join', { method: 'POST', body: { code: code.code } })).status, 201);
  }
  assert.equal((await owner.as('/api/members')).payload.invites[0].status, 'active');
});

test('a code set aside for one address refuses anybody else', async () => {
  const owner = await signUpOwner(app.call, { email: 'codes7@example.com' });
  const code = await makeCode(owner, { role: 'staff', all_locations: true, email: 'Expected@Example.com' });

  const wrong = await signUp(app.call, { email: 'someone-else@example.com' });
  const refused = await wrong.as('/api/join', { method: 'POST', body: { code: code.code } });
  assert.equal(refused.status, 400);
  assert.match(refused.payload.error, /set aside for/);

  // The address the code names is joined as soon as they sign in, and typing the
  // code afterwards simply confirms it rather than erroring.
  const right = await signUp(app.call, { email: 'expected@example.com' });
  assert.equal((await right.as('/api/auth/me')).payload.member.account_name, 'Test Cafe');
  assert.equal((await right.as('/api/join', { method: 'POST', body: { code: code.code } })).status, 201);
});

test('a turned-off code stops working, and says so', async () => {
  const owner = await signUpOwner(app.call, { email: 'codes8@example.com' });
  const code = await makeCode(owner, { role: 'staff', all_locations: true, max_uses: 5 });
  await owner.as(`/api/invites/${code.id}/revoke`, { method: 'POST' });

  const late = await signUp(app.call, { email: 'late@example.com' });
  const refused = await late.as('/api/join', { method: 'POST', body: { code: code.code } });
  assert.equal(refused.status, 400);
  assert.match(refused.payload.error, /turned off/);
  assert.equal((await owner.as('/api/members')).payload.invites[0].status, 'spent');
});

test('an expired code stops working', async () => {
  const owner = await signUpOwner(app.call, { email: 'codes9@example.com' });
  const code = await makeCode(owner, { role: 'staff', all_locations: true, expires_in_days: 7 });
  await db.run("UPDATE invites SET expires_at = now() - INTERVAL '1 day' WHERE id = :id", { id: code.id });

  const late = await signUp(app.call, { email: 'toolate@example.com' });
  const refused = await late.as('/api/join', { method: 'POST', body: { code: code.code } });
  assert.equal(refused.status, 400);
  assert.match(refused.payload.error, /expired/);
});

test('a made-up code is refused plainly', async () => {
  const person = await signUp(app.call, { email: 'guesser@example.com' });
  const refused = await person.as('/api/join', { method: 'POST', body: { code: 'NOPE-1234' } });
  assert.equal(refused.status, 400);
  assert.match(refused.payload.error, /does not exist/);
  assert.equal((await person.as('/api/join', { method: 'POST', body: {} })).status, 400);
  assert.equal((await app.call('/api/join/NOPE-1234')).status, 400);
});

test('someone already on an account cannot join another with a code', async () => {
  const cafe = await signUpOwner(app.call, { email: 'cafe2@example.com', accountName: 'Cafe Two', locations: ['One'] });
  const deli = await signUpOwner(app.call, { email: 'deli2@example.com', accountName: 'Deli Two', locations: ['Two'] });
  const code = await makeCode(deli, { role: 'staff', all_locations: true });

  const refused = await cafe.as('/api/join', { method: 'POST', body: { code: code.code } });
  assert.equal(refused.status, 400);
  assert.match(refused.payload.error, /already belong/);
});

test('only an owner hands out join codes', async () => {
  const owner = await signUpOwner(app.call, { email: 'codes10@example.com' });
  const manager = await addPerson(owner, { email: 'mgr2@example.com', role: 'manager', all_locations: true });
  assert.equal((await manager.as('/api/members/invite', { method: 'POST', body: { role: 'staff', all_locations: true } })).status, 403);

  const code = await makeCode(owner, { role: 'staff', all_locations: true });
  assert.equal((await manager.as(`/api/invites/${code.id}/revoke`, { method: 'POST' })).status, 403);
  assert.equal((await app.call(`/api/invites/${code.id}/revoke`, { method: 'POST' })).status, 401);
});

test('a code cannot grant locations belonging to another business', async () => {
  const cafe = await signUpOwner(app.call, { email: 'cafe3@example.com', accountName: 'Cafe Three', locations: ['Cafe One'] });
  const deli = await signUpOwner(app.call, { email: 'deli3@example.com', accountName: 'Deli Three', locations: ['Deli One'] });

  const refused = await cafe.as('/api/members/invite', {
    method: 'POST', body: { role: 'staff', store_ids: [deli.stores[0].id] },
  });
  assert.equal(refused.status, 400, 'a location that is not theirs counts for nothing');
});

test('a code lists the locations it grants, by name', async () => {
  const owner = await signUpOwner(app.call, { email: 'codes11@example.com' });
  const [downtown, riverside] = owner.stores;

  await makeCode(owner, { role: 'staff', store_ids: [downtown.id], label: 'One shop' });
  await makeCode(owner, { role: 'manager', all_locations: true, label: 'Everywhere' });

  const invites = (await owner.as('/api/members')).payload.invites;
  const single = invites.find((i) => i.label === 'One shop');
  const every = invites.find((i) => i.label === 'Everywhere');

  assert.deepEqual(single.store_ids, [downtown.id], 'ids come back as numbers, not strings');
  assert.deepEqual(single.locations, [downtown.name]);
  assert.deepEqual(every.locations.sort(), [downtown.name, riverside.name].sort());
});
