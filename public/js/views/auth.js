import { api, el, field, input, toast } from '../util.js';
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
          : 'Pick a password and you are in \u2014 no confirmation email, no code. '
            + 'If someone invited you, use the address they invited.',
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
          await session.signUp({
            email: email.value.trim(),
            password: password.value,
            display_name: name.value.trim(),
          });
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

/**
 * Signed in, but not attached to a business yet: either start one, or join an
 * existing one with the code its owner handed out.
 */
export function accountSetupScreen(onDone) {
  const host = el('div.auth-shell');
  let choice = 'join';

  const render = () => {
    host.replaceChildren(el('div.auth-card.wide', {}, [
      el('h1', { text: 'Getting started' }),
      el('p.muted', { text: `Signed in as ${session.user()?.email}.` }),
      el('div.tabs.sub', {}, [
        el('button.tab', {
          type: 'button', text: 'Join a business', class: choice === 'join' ? 'active' : '',
          onclick: () => { choice = 'join'; render(); },
        }),
        el('button.tab', {
          type: 'button', text: 'Start a new business', class: choice === 'create' ? 'active' : '',
          onclick: () => { choice = 'create'; render(); },
        }),
      ]),
      choice === 'join' ? joinForm(onDone) : createForm(onDone),
      el('button.link', { type: 'button', text: 'Sign out', onclick: async () => { await session.signOut(); onDone(); } }),
    ]));
  };

  render();
  return host;
}

/** Type the code you were given; the app names the business before you commit to it. */
function joinForm(onDone) {
  const code = input({ placeholder: 'e.g. BREW-4K7Q', autocapitalize: 'characters', autocomplete: 'off' });
  const message = el('p.auth-message');
  const preview = el('div.code-preview');

  let lastLooked = '';
  const look = async () => {
    const value = code.value.trim();
    if (value === lastLooked) return;
    lastLooked = value;
    preview.replaceChildren();
    message.textContent = '';
    if (value.length < 4) return;

    try {
      const info = await api(`/join/${encodeURIComponent(value)}`);
      preview.replaceChildren(
        el('div.strong', { text: info.account_name }),
        el('div.muted.small', {
          text: `Joining as ${info.role} \u00b7 ${info.all_locations ? 'all locations' : info.locations.join(', ') || 'no locations yet'}`,
        }),
      );
    } catch (err) {
      message.textContent = err.message;
      message.className = 'auth-message bad';
    }
  };

  code.addEventListener('blur', look);
  code.addEventListener('change', look);

  return el('form.stack.gap', { onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('/join', { method: 'POST', body: { code: code.value.trim() } });
      await session.refresh();
      onDone();
    } catch (err) {
      message.textContent = err.message;
      message.className = 'auth-message bad';
    }
  } }, [
    field('Join code', code, 'Whoever runs the business creates one for you under People'),
    preview,
    message,
    el('button.btn', { type: 'submit', text: 'Join' }),
  ]);
}

/** Start a new business: name it and its locations. */
function createForm(onDone) {
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

  const form = el('form.stack.gap', { onsubmit: submit }, [
    el('p.muted', { text: 'Name the business and its locations \u2014 you can add more later.' }),
    field('Business name', name),
    el('h3.section-title', { text: 'Locations' }),
    locationRows,
    el('button.btn.ghost.small', { type: 'button', text: '+ Add another location', onclick: () => addLocation() }),
    message,
    el('button.btn', { type: 'submit', text: 'Create account' }),
  ]);

  async function submit(e) {
    e.preventDefault();
    const locations = [...locationRows.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
    if (!locations.length) { message.textContent = 'Add at least one location'; message.className = 'auth-message bad'; return; }

    try {
      await api('/accounts', { method: 'POST', body: { name: name.value.trim(), locations } });
      await session.refresh();
      onDone();
    } catch (err) {
      message.textContent = err.message;
      message.className = 'auth-message bad';
    }
  }

  return form;
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

/** The API answered, but with a reason it cannot run yet: a missing setting, an unreachable database. */
export function startupErrorScreen(message, onRetry) {
  return el('div.auth-shell', {}, [
    el('div.auth-card.wide', {}, [
      el('div.auth-brand', {}, [el('span.brand-mark', { text: '\u{1F4E6}' }), el('h1', { text: 'Inventory & Ordering' })]),
      el('h2', { text: 'The server is not ready' }),
      el('p.startup-error', { text: message }),
      el('p.muted.small', { text: 'Once the setting is in place, deploy again (or restart the server) and try once more.' }),
      el('button.btn', { text: 'Try again', onclick: onRetry }),
    ]),
  ]);
}
