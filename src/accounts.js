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

/**
 * A join code is a short, readable string an owner hands out: BREW-4K7Q. Whoever
 * types it joins that account with the role and locations the code carries.
 * Letters that look alike (I, O, 0, 1) are left out so a code read aloud or written
 * on a whiteboard still works.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode(accountName = '') {
  const prefix = (String(accountName).replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4) || 'JOIN');
  const bytes = crypto.randomBytes(4);
  const body = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${prefix}-${body}`;
}

function normaliseCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

/** Why a code cannot be used, or null when it is good. */
function codeProblem(invite, email = null) {
  if (!invite) return 'That join code does not exist. Check it with whoever gave it to you.';
  if (invite.revoked_at) return 'That join code has been turned off.';
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return 'That join code has expired.';
  if (invite.max_uses != null && invite.uses >= invite.max_uses) return 'That join code has already been used up.';
  if (invite.email && email && normaliseEmail(invite.email) !== normaliseEmail(email)) {
    return `That join code was set aside for ${invite.email}.`;
  }
  return null;
}

/** Looks a code up without joining anything, so the sign-up screen can show what it is for. */
async function describeCode(code, email = null) {
  const invite = await db.one(`
    SELECT i.*, a.name AS account_name FROM invites i JOIN accounts a ON a.id = i.account_id
    WHERE upper(i.code) = :code
  `, { code: normaliseCode(code) });

  const problem = codeProblem(invite, email);
  if (problem) throw httpError(400, problem);

  const stores = invite.all_locations
    ? await db.all('SELECT name FROM stores WHERE account_id = :account ORDER BY name', { account: invite.account_id })
    : await db.all('SELECT name FROM stores WHERE id = ANY(:ids) ORDER BY name', { ids: invite.store_ids.length ? invite.store_ids : [0] });

  return {
    account_name: invite.account_name,
    role: invite.role,
    all_locations: invite.all_locations,
    locations: stores.map((s) => s.name),
  };
}

/** Joins the signed-in user to the account a code belongs to. */
async function redeemCode(user, code) {
  const invite = await db.one(`
    SELECT i.*, a.name AS account_name FROM invites i JOIN accounts a ON a.id = i.account_id
    WHERE upper(i.code) = :code
  `, { code: normaliseCode(code) });

  if (!invite) throw httpError(400, codeProblem(null));

  // Where this person already stands is settled before the code's limits are, because
  // a code tied to an email joins them the moment they sign in and is spent by doing
  // so — typing it afterwards should confirm where they landed, not read as an error.
  const already = await db.one('SELECT * FROM members WHERE user_id = :userId', { userId: user.id });
  if (already) {
    if (already.account_id === invite.account_id) return { ...already, account_name: invite.account_name };
    throw httpError(400, 'You already belong to another account');
  }

  const problem = codeProblem(invite, user.email);
  if (problem) throw httpError(400, problem);

  return joinFromInvite(user, invite);
}

/** Shared by code redemption and the email match: creates the membership the invite describes. */
async function joinFromInvite(user, invite) {
  return tx(async (t) => {
    const member = await t.one(`
      INSERT INTO members (account_id, user_id, email, display_name, role, all_locations)
      VALUES (:account, :userId, :email, :name, :role, :all)
      ON CONFLICT (account_id, user_id) DO UPDATE SET email = excluded.email
      RETURNING *
    `, {
      account: invite.account_id,
      userId: user.id,
      email: normaliseEmail(user.email),
      name: user.display_name || '',
      role: invite.role,
      all: invite.all_locations,
    });

    for (const storeId of invite.store_ids || []) {
      await t.run(`INSERT INTO member_locations (member_id, store_id) VALUES (:member, :store)
                   ON CONFLICT DO NOTHING`, { member: member.id, store: storeId });
    }

    // A code with a use limit counts down; a single-use one is spent here.
    await t.run(`
      UPDATE invites SET uses = uses + 1,
                         accepted_at = COALESCE(accepted_at, now())
      WHERE id = :id
    `, { id: invite.id });

    const account = await t.one('SELECT name FROM accounts WHERE id = :id', { id: invite.account_id });
    return { ...member, account_name: account.name };
  });
}

/** A code tied to an email is applied automatically the first time that person signs in. */
async function acceptPendingInvite(user) {
  const email = normaliseEmail(user.email);
  if (!email) return null;

  const invite = await db.one(`
    SELECT * FROM invites
    WHERE lower(email) = :email
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND (max_uses IS NULL OR uses < max_uses)
    ORDER BY created_at
    LIMIT 1
  `, { email });
  if (!invite) return null;

  return joinFromInvite(user, invite);
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

    const names = locations.map((n) => String(n).trim()).filter(Boolean).slice(0, 20);
    const taken = new Set();
    let index = 0;
    for (const locationName of names.length ? names : ['Store 1']) {
      index += 1;
      await t.run(`INSERT INTO stores (account_id, name, code) VALUES (:account, :name, :code)`, {
        account: account.id,
        name: locationName,
        code: codeFor(locationName, index, taken),
      });
    }

    return { ...member, account_name: account.name, store_ids: [], permissions: ROLE_ACTIONS.owner };
  });
}

/**
 * A short code for a location, taken from its name. "Store 1" and "Store 2" both
 * start with the same four letters, so a taken code falls back to the name's digits
 * and then to a plain number rather than colliding.
 */
function codeFor(name, index, taken = new Set()) {
  const letters = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const digits = (name.match(/\d+/) || [])[0] || '';

  const candidates = [
    digits ? `${letters.replace(/\d+/g, '').slice(0, 3)}${digits}` : letters.slice(0, 4),
    letters.slice(0, 4),
    `${letters.slice(0, 3)}${index}`,
    `S${index}`,
  ].map((c) => c.slice(0, 8)).filter(Boolean);

  const chosen = candidates.find((c) => !taken.has(c)) || `S${index}`;
  taken.add(chosen);
  return chosen;
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
  const rows = await db.all(`
    SELECT i.*, (SELECT email FROM members WHERE id = i.invited_by) AS invited_by_email
    FROM invites i WHERE i.account_id = :account
    ORDER BY i.revoked_at NULLS FIRST, i.created_at DESC
  `, { account: accountId });

  const stores = await db.all('SELECT id, name FROM stores WHERE account_id = :account', { account: accountId });
  const nameFor = (id) => stores.find((s) => s.id === id)?.name;

  return rows.map((invite) => ({
    ...invite,
    locations: invite.all_locations ? stores.map((s) => s.name) : (invite.store_ids || []).map(nameFor).filter(Boolean),
    uses_left: invite.max_uses == null ? null : Math.max(0, invite.max_uses - invite.uses),
    status: codeProblem(invite) ? 'spent' : 'active',
    reason: codeProblem(invite),
  }));
}

/**
 * Creates a join code. Give it a role and the locations it grants; optionally tie it
 * to one email address, cap how many people may use it, or set it to expire.
 */
async function createInvite(member, {
  email = null, role = 'staff', all_locations = false, store_ids = [],
  label = '', max_uses = 1, expires_in_days = null,
} = {}) {
  assertCan(member, 'manage_account');
  if (!ROLES.includes(role)) throw httpError(400, 'Unknown role');

  const cleanEmail = email ? normaliseEmail(email) : null;
  if (cleanEmail && !cleanEmail.includes('@')) throw httpError(400, 'Enter a valid email address, or leave it blank');

  if (cleanEmail) {
    const already = await db.one('SELECT id FROM members WHERE account_id = :account AND lower(email) = :email',
      { account: member.account_id, email: cleanEmail });
    if (already) throw httpError(400, 'That person is already on this account');
  }

  const stores = await validStoreIds(member.account_id, store_ids);
  if (!all_locations && !stores.length) throw httpError(400, 'Choose at least one location for this code');

  const uses = max_uses === null || max_uses === '' ? null : Number(max_uses);
  if (uses !== null && !(uses > 0)) throw httpError(400, 'A code has to allow at least one use');

  const days = expires_in_days === null || expires_in_days === '' ? null : Number(expires_in_days);
  if (days !== null && !(days > 0)) throw httpError(400, 'An expiry has to be at least a day away');

  const account = await db.one('SELECT name FROM accounts WHERE id = :id', { id: member.account_id });

  // A collision is vanishingly unlikely, but a retry costs nothing.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.one(`
        INSERT INTO invites (account_id, email, role, all_locations, store_ids, label,
                             code, token, invited_by, max_uses, expires_at)
        VALUES (:account, :email, :role, :all, :stores, :label,
                :code, :token, :by, :maxUses,
                CASE WHEN :days::int IS NULL THEN NULL ELSE now() + (:days::int * INTERVAL '1 day') END)
        RETURNING *
      `, {
        account: member.account_id,
        email: cleanEmail,
        role,
        all: !!all_locations,
        stores,
        label: label || '',
        code: makeCode(account.name),
        token: crypto.randomBytes(24).toString('base64url'),
        by: member.id,
        maxUses: uses,
        days,
      });
    } catch (err) {
      if (err.code !== '23505' || attempt === 4) throw err;
    }
  }
  throw httpError(500, 'Could not generate a join code, please try again');
}

async function revokeInvite(member, inviteId) {
  assertCan(member, 'manage_account');
  const updated = await db.one(`
    UPDATE invites SET revoked_at = now() WHERE id = :id AND account_id = :account RETURNING id
  `, { id: inviteId, account: member.account_id });
  if (!updated) throw httpError(404, 'That join code is not on this account');
  return { ok: true };
}

async function deleteInvite(member, inviteId) {
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
  assertStoreAccess, listMembers, listInvites, createInvite, revokeInvite, deleteInvite,
  describeCode, redeemCode, normaliseCode, updateMember, removeMember, httpError,
};
