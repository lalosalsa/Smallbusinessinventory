'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');

/**
 * Sign-in. Two modes, chosen by what is configured:
 *
 *   local    - the default. The server keeps its own email/password sign-in, so
 *              signing up is one form and you are in: no confirmation email, no
 *              verification code, no magic link.
 *   supabase - opt in with AUTH_MODE=supabase. The browser signs in with Supabase
 *              Auth and sends its access token; the server checks it with Supabase.
 *              Turn "Confirm email" off in the Supabase dashboard unless you want
 *              new people to have to click a link before they can sign in.
 *
 * Either way the app's own `members` table decides what a signed-in person may do.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const TOKEN_TTL_SECONDS = Number(process.env.AUTH_TOKEN_TTL) || 60 * 60 * 24 * 30;

// Local sign-in is the default, even when the database is a Supabase one: a new
// person picks a password and is straight in, with no confirmation email, no code
// and no magic link. Supabase Auth is opt-in with AUTH_MODE=supabase.
const MODE = resolveMode();

function resolveMode() {
  const wanted = String(process.env.AUTH_MODE || 'local').toLowerCase();
  if (wanted !== 'supabase') return 'local';
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('AUTH_MODE=supabase needs SUPABASE_URL and SUPABASE_ANON_KEY as well');
  }
  return 'supabase';
}

let supabaseClient = null;
function supabase() {
  if (!supabaseClient) {
    const { createClient } = require('@supabase/supabase-js');
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseClient;
}

function authMode() { return MODE; }

/** What the browser needs to know before anyone has signed in. Public values only. */
function publicConfig() {
  return MODE === 'supabase'
    ? { mode: MODE, supabase_url: SUPABASE_URL, supabase_anon_key: SUPABASE_ANON_KEY }
    : { mode: MODE };
}

/* ------------------------------------------------------------ local sign-in */

const SECRET_FILE = process.env.AUTH_SECRET_FILE || path.join(__dirname, '..', 'data', '.auth-secret');

function secret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {}
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
  return generated;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function base64url(buf) { return Buffer.from(buf).toString('base64url'); }

function signLocalToken(payload) {
  const body = base64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }));
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function readLocalToken(token) {
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload;
}

async function registerLocalUser({ email, password, display_name = '' }) {
  if (MODE !== 'local') throw badRequest('This app signs in through Supabase');
  const clean = normaliseEmail(email);
  if (!clean) throw badRequest('An email address is required');
  if (!password || String(password).length < 8) throw badRequest('Use a password of at least 8 characters');

  const existing = await db.one('SELECT id FROM local_users WHERE lower(email) = :email', { email: clean });
  if (existing) throw badRequest('That email already has an account — sign in instead');

  const user = await db.one(`
    INSERT INTO local_users (email, display_name, password_hash)
    VALUES (:email, :name, :hash) RETURNING id, email, display_name
  `, { email: clean, name: display_name || '', hash: hashPassword(password) });

  return { user: shape(user), token: signLocalToken({ sub: user.id, email: user.email }) };
}

async function loginLocal({ email, password }) {
  if (MODE !== 'local') throw badRequest('This app signs in through Supabase');
  const user = await db.one('SELECT * FROM local_users WHERE lower(email) = :email', { email: normaliseEmail(email) });
  if (!user || !verifyPassword(password || '', user.password_hash)) throw unauthorised('Email or password is wrong');
  return { user: shape(user), token: signLocalToken({ sub: user.id, email: user.email }) };
}

async function changeLocalPassword(userId, { current_password, new_password }) {
  if (MODE !== 'local') throw badRequest('Passwords are managed by Supabase');
  const user = await db.one('SELECT * FROM local_users WHERE id = :id', { id: userId });
  if (!user || !verifyPassword(current_password || '', user.password_hash)) throw unauthorised('Current password is wrong');
  if (!new_password || String(new_password).length < 8) throw badRequest('Use a password of at least 8 characters');
  await db.run('UPDATE local_users SET password_hash = :hash WHERE id = :id', { hash: hashPassword(new_password), id: userId });
  return { ok: true };
}

/* -------------------------------------------------------- token verification */

// Supabase round-trips cost a request each, so hold verified tokens briefly.
const cache = new Map();
const CACHE_MS = 60_000;

async function verifyToken(token) {
  if (!token) return null;

  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;

  let user = null;
  if (MODE === 'local') {
    const payload = readLocalToken(token);
    if (payload) {
      const row = await db.one('SELECT id, email, display_name FROM local_users WHERE id = :id', { id: payload.sub });
      user = row ? shape(row) : null;
    }
  } else {
    const { data, error } = await supabase().auth.getUser(token);
    if (!error && data?.user) {
      user = {
        id: data.user.id,
        email: normaliseEmail(data.user.email || ''),
        display_name: data.user.user_metadata?.full_name || data.user.user_metadata?.name || '',
      };
    }
  }

  if (user) {
    cache.set(token, { user, until: Date.now() + CACHE_MS });
    if (cache.size > 500) for (const [k, v] of cache) if (v.until < Date.now()) cache.delete(k);
  }
  return user;
}

function forgetToken(token) { cache.delete(token); }

function shape(row) {
  return { id: row.id, email: normaliseEmail(row.email), display_name: row.display_name || '' };
}

function normaliseEmail(email) { return String(email || '').trim().toLowerCase(); }

function badRequest(message) { const e = new Error(message); e.status = 400; return e; }
function unauthorised(message) { const e = new Error(message); e.status = 401; return e; }

module.exports = {
  authMode, publicConfig, verifyToken, forgetToken, registerLocalUser, loginLocal,
  changeLocalPassword, normaliseEmail, hashPassword, verifyPassword,
};
