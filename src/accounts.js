'use strict';

const crypto = require('crypto');
const { db, tx } = require('./db');
const { normaliseEmail } = require('./auth');

/**
 * One account per business. Everything else in the database hangs off it.
 *
 * Roles:
 *   owner   - everything, including locations, people and billing-level settings
 *   manager - products, suppliers, pars, orders and schedules, at their locations
 *   staff   - counts stock and reads, at their locations only
 *
 * Owners always reach every location. A manager or staff member reaches only the
 * locations assigned to them, unless they are marked as covering all of them.
 */

const ROLES = ['owner', 'manager', 'staff'];

const ROLE_ACTIONS = {
  owner: ['view', 'count', 'manage_catalog', 'manage_orders', 'manage_account'],
  manager: ['view', 'count', 'manage_catalog', 'manage_orders'],
  staff: ['view', 'count'],
};

function can(member, action) {
  return !!member && (ROLE_ACTIONS[member.role] || []).includes(action);
}

function assertCan(member, action) {
  if (!can(member, action)) {
    throw httpError(403, action === 'manage_account'
      ? 'Only an account owner can do that'
      : 'Your role does not allow that');
  }
}

/** Loads the membership for a signed-in user, accepting any invitation waiting for them. */
async function membershipFor(user) {
  let member = await db.one(`
    SELECT m.*, a.name AS account_name
    FROM members m JOIN accounts a ON a.id = m.account_id
    WHERE m.user_id = :userId
    ORDER BY m.created_at
    LIMIT 1
  `, { userId: user.id });

  if (!member) member = await acceptPendingInvite(user);
  if (!member) return null;

  member.store_ids = await allowedStoreIds(member);
  member.permissions = ROLE_ACTIONS[member.role] || [];
  return member;
}

/** An invitation is matched on email the first time that person signs in. */
async function acceptPendingInvite(user) {
  const email = normaliseEmail(user.email);
  if (!email) return null;

  const invite = await db.one(`
    SELECT * FROM invites WHERE lower(email) = :email AND accepted_at IS NULL
    ORDER BY created_at LIMIT 1
  `, { email });
  if (!invite) return null;

  return tx(async (t) => {
    const member = await t.one(`
      INSERT INTO members (account_id, user_id, email, display_name, role, all_locations)
      VALUES (:account, :userId, :email, :name, :role, :all)
      ON CONFLICT (account_id, user_id) DO UPDATE SET email = excluded.email
      RETURNING *
    `, {
      account: invite.account_id,
      userId: user.id,
      email,
      name: user.display_name || '',
      role: invite.role,
      all: invite.all_locations,
    });

    for (const storeId of invite.store_ids || []) {
      await t.run(`INSERT INTO member_locations (member_id, store_id) VALUES (:member, :store)
                   ON CONFLICT DO NOTHING`, { member: member.id, store: storeId });
    }
    await t.run('UPDATE invites SET accepted_at = now() WHERE id = :id', { id: invite.id });

    const account = await t.one('SELECT name FROM accounts WHERE id = :id', { id: invite.account_id });
    return { ...member, account_name: account.name };
  });
}

/** Creates a business, makes the signed-in user its owner, and sets up two locations. */
async function createAccount(user, { name, locations = ['Store 1', 'Store 2'] }) {
  const accountName = String(name || '').trim();
  if (!accountName) throw httpError(400, 'Give the business a name');

  const existing = await db.one('SELECT id FROM members WHERE user_id = :userId', { userId: user.id });
  if (existing) throw httpError(400, 'You already belong to an account');

  return tx(async (t) => {
    const account = await t.one('INSERT INTO accounts (name) VALUES (:name) RETURNING *', { name: accountName });
    const member = await t.one(`
      INSERT INTO members (account_id, user_id, email, display_name, role, all_locations)
      VALUES (:account, :userId, :email, :name, 'owner', true) RETURNING *
    `, { account: account.id, userId: user.id, email: normaliseEmail(user.email), name: user.display_name || '' });

    const names = locations.filter((n) => String(n).trim()).slice(0, 20);
    let index = 0;
    for (const locationName of names.length ? names : ['Store 1']) {
      index += 1;
      await t.run(`INSERT INTO stores (account_id, name, code) VALUES (:account, :name, :code)`, {
        account: account.id,
        name: String(locationName).trim(),
        code: codeFor(String(locationName).trim(), index),
      });
    }

    return { ...member, account_name: account.name, store_ids: [], permissions: ROLE_ACTIONS.owner };
  });
}

function codeFor(name, index) {
  const letters = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return (letters.slice(0, 4) || `S${index}`).slice(0, 8) || `S${index}`;
}

/** The store ids a member may work in: every active store for an owner or an all-locations member. */
async function allowedStoreIds(member) {
  if (member.role === 'owner' || member.all_locations) {
    const rows = await db.all('SELECT id FROM stores WHERE account_id = :account ORDER BY name', { account: member.account_id });
    return rows.map((r) => r.id);
  }
  const rows = await db.all(`
    SELECT s.id FROM member_locations ml JOIN stores s ON s.id = ml.store_id
    WHERE ml.member_id = :member AND s.account_id = :account ORDER BY s.name
  `, { member: member.id, account: member.account_id });
  return rows.map((r) => r.id);
}

function assertStoreAccess(member, storeId) {
  const id = Number(storeId);
  if (!id) throw httpError(400, 'A location is required');
  if (!member.store_ids.includes(id)) throw httpError(403, 'You do not have access to that location');
  return id;
}

/* ------------------------------------------------------------------ people */

async function listMembers(accountId) {
  const members = await db.all(`
    SELECT m.*, (SELECT count(*)::int FROM counts c WHERE c.counted_by = m.id) AS counts_taken
    FROM members m WHERE m.account_id = :account ORDER BY m.role, lower(m.email)
  `, { account: accountId });

  const locations = await db.all(`
    SELECT ml.member_id, s.id AS store_id, s.name AS store_name
    FROM member_locations ml JOIN stores s ON s.id = ml.store_id
    WHERE s.account_id = :account
  `, { account: accountId });

  return members.map((m) => ({
    ...m,
    locations: locations.filter((l) => l.member_id === m.id),
  }));
}

async function listInvites(accountId) {
  return db.all(`
    SELECT i.*, (SELECT email FROM members WHERE id = i.invited_by) AS invited_by_email
    FROM invites i WHERE i.account_id = :account AND i.accepted_at IS NULL
    ORDER BY i.created_at DESC
  `, { account: accountId });
}

/**
 * Invites someone by email. They join with this role and these locations the first
 * time they sign in with that address.
 */
async function inviteMember(member, { email, role = 'staff', all_locations = false, store_ids = [] }) {
  assertCan(member, 'manage_account');
  const clean = normaliseEmail(email);
  if (!clean || !clean.includes('@')) throw httpError(400, 'Enter a valid email address');
  if (!ROLES.includes(role)) throw httpError(400, 'Unknown role');

  const already = await db.one(`
    SELECT id FROM members WHERE account_id = :account AND lower(email) = :email
  `, { account: member.account_id, email: clean });
  if (already) throw httpError(400, 'That person is already on this account');

  const stores = await validStoreIds(member.account_id, store_ids);
  if (!all_locations && !stores.length) throw httpError(400, 'Choose at least one location for them');

  return db.one(`
    INSERT INTO invites (account_id, email, role, all_locations, store_ids, token, invited_by)
    VALUES (:account, :email, :role, :all, :stores, :token, :by)
    ON CONFLICT (account_id, email) DO UPDATE SET
      role = excluded.role, all_locations = excluded.all_locations,
      store_ids = excluded.store_ids, accepted_at = NULL, created_at = now()
    RETURNING *
  `, {
    account: member.account_id,
    email: clean,
    role,
    all: !!all_locations,
    stores,
    token: crypto.randomBytes(24).toString('base64url'),
    by: member.id,
  });
}

async function revokeInvite(member, inviteId) {
  assertCan(member, 'manage_account');
  await db.run('DELETE FROM invites WHERE id = :id AND account_id = :account',
    { id: inviteId, account: member.account_id });
  return { ok: true };
}

async function updateMember(actor, memberId, { role, all_locations, store_ids, display_name }) {
  assertCan(actor, 'manage_account');
  const target = await db.one('SELECT * FROM members WHERE id = :id AND account_id = :account',
    { id: memberId, account: actor.account_id });
  if (!target) throw httpError(404, 'That person is not on this account');

  if (role && !ROLES.includes(role)) throw httpError(400, 'Unknown role');
  if (role && role !== 'owner' && target.role === 'owner') await assertNotLastOwner(actor.account_id, target.id);

  const stores = store_ids === undefined ? null : await validStoreIds(actor.account_id, store_ids);

  return tx(async (t) => {
    await t.run(`
      UPDATE members SET
        role = COALESCE(:role, role),
        all_locations = COALESCE(:all, all_locations),
        display_name = COALESCE(:name, display_name)
      WHERE id = :id
    `, {
      role: role || null,
      all: all_locations === undefined ? null : !!all_locations,
      name: display_name === undefined ? null : display_name,
      id: memberId,
    });

    if (stores) {
      await t.run('DELETE FROM member_locations WHERE member_id = :id', { id: memberId });
      for (const storeId of stores) {
        await t.run('INSERT INTO member_locations (member_id, store_id) VALUES (:id, :store)', { id: memberId, store: storeId });
      }
    }
    return t.one('SELECT * FROM members WHERE id = :id', { id: memberId });
  });
}

async function removeMember(actor, memberId) {
  assertCan(actor, 'manage_account');
  if (actor.id === memberId) throw httpError(400, 'You cannot remove yourself');
  const target = await db.one('SELECT * FROM members WHERE id = :id AND account_id = :account',
    { id: memberId, account: actor.account_id });
  if (!target) throw httpError(404, 'That person is not on this account');
  if (target.role === 'owner') await assertNotLastOwner(actor.account_id, memberId);
  await db.run('DELETE FROM members WHERE id = :id', { id: memberId });
  return { ok: true };
}

async function assertNotLastOwner(accountId, memberId) {
  const owners = await db.value(`
    SELECT count(*)::int FROM members WHERE account_id = :account AND role = 'owner' AND id <> :id
  `, { account: accountId, id: memberId });
  if (!owners) throw httpError(400, 'An account needs at least one owner');
}

async function validStoreIds(accountId, ids) {
  const wanted = (ids || []).map(Number).filter(Boolean);
  if (!wanted.length) return [];
  const rows = await db.all('SELECT id FROM stores WHERE account_id = :account AND id = ANY(:ids)',
    { account: accountId, ids: wanted });
  return rows.map((r) => r.id);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  ROLES, ROLE_ACTIONS, can, assertCan, membershipFor, createAccount, allowedStoreIds,
  assertStoreAccess, listMembers, listInvites, inviteMember, revokeInvite, updateMember,
  removeMember, httpError,
};
