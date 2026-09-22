import { el, field, input, toast } from '../util.js';
import * as session from '../session.js';

/** The signed-out screen: sign in, or create a sign-in. */
export function authScreen(onDone) {
  let mode = 'sign-in';
  const host = el('div.auth-shell');

  function render() {
    const email = input({ type: 'email', required: true, autocomplete: 'email', placeholder: 'you@yourbusiness.com' });
    const password = input({ type: 'password', required: true, autocomplete: mode === 'sign-in' ? 'current-password' : 'new-password' });
    const name = input({ autocomplete: 'name', placeholder: 'Your name' });
    const message = el('p.auth-message');

    const form = el('form.auth-card', { onsubmit: submit }, [
      el('div.auth-brand', {}, [el('span.brand-mark', { text: '\u{1F4E6}' }), el('h1', { text: 'Inventory & Ordering' })]),
      el('p.muted', {
        text: mode === 'sign-in'
          ? 'Sign in to your business account.'
          : 'Create a sign-in. If someone has invited you, use the address they invited.',
      }),
      mode === 'sign-up' ? field('Your name', name) : null,
      field('Email', email),
      field('Password', password, mode === 'sign-up' ? 'At least 8 characters' : null),
      message,
      el('button.btn.block', { type: 'submit', text: mode === 'sign-in' ? 'Sign in' : 'Create sign-in' }),
      el('p.auth-switch', {}, [
        el('span.muted', { text: mode === 'sign-in' ? 'No sign-in yet? ' : 'Already have one? ' }),
        el('button.link', {
          type: 'button',
          text: mode === 'sign-in' ? 'Create one' : 'Sign in',
          onclick: () => { mode = mode === 'sign-in' ? 'sign-up' : 'sign-in'; render(); },
        }),
      ]),
      session.mode() === 'supabase' && mode === 'sign-in'
        ? el('button.link.small', { type: 'button', text: 'Forgot password', onclick: async () => {
          if (!email.value) { toast('Enter your email first', 'warn'); return; }
          try { await session.resetPassword(email.value); toast('Check your email for a reset link'); }
          catch (err) { toast(err.message, 'bad'); }
        } })
        : null,
    ]);

    host.replaceChildren(form);
    email.focus();

    async function submit(e) {
      e.preventDefault();
      message.textContent = '';
      try {
        if (mode === 'sign-in') {
          await session.signIn({ email: email.value.trim(), password: password.value });
        } else {
          const res = await session.signUp({
            email: email.value.trim(),
            password: password.value,
            display_name: name.value.trim(),
          });
          if (res.needsConfirmation) {
            message.textContent = res.message;
            message.className = 'auth-message ok';
            mode = 'sign-in';
            return;
          }
        }
        onDone();
      } catch (err) {
        message.textContent = err.message;
        message.className = 'auth-message bad';
      }
    }
  }

  render();
  return host;
}

/** Signed in, but not attached to a business yet. */
export function accountSetupScreen(onDone) {
  const name = input({ required: true, placeholder: 'e.g. Riverside Coffee Co' });
  const locationRows = el('div.stack.gap');
  const message = el('p.auth-message');

  const addLocation = (value = '') => {
    const row = el('div.row.gap', {}, [
      input({ value, placeholder: 'Location name', class: 'grow' }),
      el('button.icon-btn', { type: 'button', text: '×', title: 'Remove', onclick: () => row.remove() }),
    ]);
    locationRows.append(row);
  };
  addLocation('Store 1');
  addLocation('Store 2');

  const form = el('form.auth-card.wide', { onsubmit: submit }, [
    el('h1', { text: 'Set up your business' }),
    el('p.muted', { text: `Signed in as ${session.user()?.email}. Name the business and its locations — you can add more later.` }),
    field('Business name', name),
    el('h3.section-title', { text: 'Locations' }),
    locationRows,
    el('button.btn.ghost.small', { type: 'button', text: '+ Add another location', onclick: () => addLocation() }),
    message,
    el('div.row.gap', {}, [
      el('button.btn', { type: 'submit', text: 'Create account' }),
      el('button.link', { type: 'button', text: 'Sign out', onclick: async () => { await session.signOut(); onDone(); } }),
    ]),
  ]);

  async function submit(e) {
    e.preventDefault();
    const locations = [...locationRows.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
    if (!locations.length) { message.textContent = 'Add at least one location'; message.className = 'auth-message bad'; return; }

    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token()}` },
        body: JSON.stringify({ name: name.value.trim(), locations }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await session.refresh();
      onDone();
    } catch (err) {
      message.textContent = err.message;
      message.className = 'auth-message bad';
    }
  }

  return el('div.auth-shell', {}, [form]);
}

/** Signed in, invited to nothing, and not an owner: nothing to show them yet. */
export function noAccessScreen(onDone) {
  return el('div.auth-shell', {}, [
    el('div.auth-card', {}, [
      el('h1', { text: 'No account yet' }),
      el('p.muted', { text: `${session.user()?.email} is not on a business account. Ask an owner to invite this address, then sign in again.` }),
      el('button.btn.ghost', { text: 'Sign out', onclick: async () => { await session.signOut(); onDone(); } }),
    ]),
  ]);
}
