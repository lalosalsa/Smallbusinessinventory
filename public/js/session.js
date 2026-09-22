// Who is signed in, and how the browser proves it to the API.
//
// With Supabase configured the browser signs in against Supabase Auth and keeps its
// access token; otherwise the app's own email/password sign-in is used. Either way the
// rest of the front end just calls `token()`.

import { readJson, request } from './http.js';

const STORAGE_KEY = 'inventory.session';

const state = {
  config: { mode: 'local' },
  token: null,
  user: null,
  member: null,
  stores: [],
  supabase: null,
};

export function token() { return state.token; }
export function user() { return state.user; }
export function member() { return state.member; }
export function stores() { return state.stores; }
export function mode() { return state.config.mode; }
export function signedIn() { return !!state.user; }
export function hasAccount() { return !!state.member; }

export function can(action) {
  return !!state.member && (state.member.permissions || []).includes(action);
}

function store(tokenValue) {
  state.token = tokenValue || null;
  try {
    if (tokenValue) localStorage.setItem(STORAGE_KEY, tokenValue);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* private browsing */ }
}

async function supabaseClient() {
  if (state.supabase) return state.supabase;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  state.supabase = createClient(state.config.supabase_url, state.config.supabase_anon_key);
  return state.supabase;
}

/** Loads the sign-in config, restores any saved session and fetches the membership. */
export async function boot() {
  state.config = await loadConfig();

  if (state.config.mode === 'supabase') {
    const client = await supabaseClient();
    const { data } = await client.auth.getSession();
    store(data?.session?.access_token || null);
    client.auth.onAuthStateChange((_event, session) => store(session?.access_token || null));
  } else {
    try { state.token = localStorage.getItem(STORAGE_KEY); } catch { state.token = null; }
  }

  await refresh();
  return state;
}

/** The sign-in config tells the browser which mode the server is in. */
async function loadConfig() {
  const res = await request('/api/auth/config');
  return readJson(res, '/api/auth/config');
}

/** Re-reads who we are: used after signing in, creating an account or changing people. */
export async function refresh() {
  if (!state.token) { state.user = null; state.member = null; state.stores = []; return state; }

  const res = await request('/api/auth/me', { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) { store(null); state.user = null; state.member = null; state.stores = []; return state; }

  const data = await readJson(res, '/api/auth/me');
  state.user = data.user;
  state.member = data.member;
  state.stores = data.stores || [];
  if (!state.user) store(null);
  return state;
}

export async function signIn({ email, password }) {
  if (state.config.mode === 'supabase') {
    const client = await supabaseClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    store(data.session.access_token);
  } else {
    const res = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await readJson(res, '/api/auth/login');
    if (!res.ok) throw new Error(data?.error || 'Could not sign in');
    store(data.token);
  }
  return refresh();
}

export async function signUp({ email, password, display_name = '' }) {
  if (state.config.mode === 'supabase') {
    const client = await supabaseClient();
    const { data, error } = await client.auth.signUp({
      email, password, options: { data: { full_name: display_name } },
    });
    if (error) throw new Error(error.message);

    // With "Confirm email" off, signing up hands back a session and the person is
    // straight in. If the project still has it on, Supabase withholds the session,
    // so say exactly which setting to turn off rather than sending them to wait on
    // an email.
    if (!data.session) {
      const retry = await client.auth.signInWithPassword({ email, password });
      if (retry.error || !retry.data?.session) {
        throw new Error('This Supabase project still asks new users to confirm their email. '
          + 'Turn off Authentication \u2192 Sign In / Providers \u2192 Email \u2192 "Confirm email" in the '
          + 'Supabase dashboard, or run the app without AUTH_MODE=supabase to use its own sign-in.');
      }
      store(retry.data.session.access_token);
      await refresh();
      return { needsConfirmation: false };
    }
    store(data.session.access_token);
  } else {
    const res = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, display_name }),
    });
    const data = await readJson(res, '/api/auth/register');
    if (!res.ok) throw new Error(data?.error || 'Could not create that sign-in');
    store(data.token);
  }
  await refresh();
  return { needsConfirmation: false };
}

export async function signOut() {
  if (state.config.mode === 'supabase' && state.supabase) await state.supabase.auth.signOut();
  else if (state.token) {
    await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } }).catch(() => {});
  }
  store(null);
  state.user = null;
  state.member = null;
  state.stores = [];
}

export async function resetPassword(email) {
  if (state.config.mode !== 'supabase') throw new Error('Ask an owner to reset it for you');
  const client = await supabaseClient();
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) throw new Error(error.message);
}
