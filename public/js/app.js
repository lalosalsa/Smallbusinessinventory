import { el, toast, clear } from './util.js';
import { route, render, setOutlet, go } from './router.js';
import { refreshReference, getState, setActiveStore, onChange } from './store.js';
import * as session from './session.js';
import { authScreen, accountSetupScreen } from './views/auth.js';
import { dashboardView } from './views/dashboard.js';
import { inventoryView } from './views/inventory.js';
import { productsView } from './views/products.js';
import { suppliersView, storesView } from './views/suppliers.js';
import { ordersView, newOrderView, orderView } from './views/orders.js';
import { schedulesView } from './views/schedules.js';
import { usageView } from './views/usage.js';
import { dataView } from './views/data.js';
import { peopleView } from './views/people.js';

// `needs` is the permission a nav entry requires; entries without one are open to all.
const NAV = [
  { path: '/', label: 'Overview' },
  { path: '/inventory', label: 'Stock & counts' },
  { path: '/orders', label: 'Orders', needs: 'manage_orders' },
  { path: '/schedule', label: 'Order schedule', needs: 'manage_orders' },
  { path: '/usage', label: 'Usage' },
  { path: '/products', label: 'Products' },
  { path: '/suppliers', label: 'Suppliers' },
  { path: '/data', label: 'Import / export' },
  { path: '/people', label: 'People' },
  { path: '/stores', label: 'Locations', needs: 'manage_account' },
];

route('/', dashboardView);
route('/inventory', inventoryView);
route('/products', productsView);
route('/suppliers', suppliersView);
route('/stores', storesView);
route('/orders', ordersView);
route('/orders/new', newOrderView);
route('/orders/:id', orderView);
route('/schedule', schedulesView);
route('/usage', usageView);
route('/data', dataView);
route('/people', peopleView);

function buildNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...NAV
    .filter((item) => !item.needs || session.can(item.needs))
    .map((item) => el('a.nav-link', { href: `#${item.path}`, text: item.label, dataset: { route: item.path } })));
}

function buildStorePicker() {
  const host = document.getElementById('store-picker');
  const { stores, activeStoreId } = getState();
  host.replaceChildren(...stores.map((s) => el('button.store-chip', {
    text: s.code,
    title: s.name,
    class: s.id === activeStoreId ? 'active' : '',
    onclick: () => { setActiveStore(s.id); render(); },
  })));
}

function buildAccountMenu() {
  const host = document.getElementById('account-menu');
  const member = session.member();
  if (!member) { host.replaceChildren(); return; }

  host.replaceChildren(el('details.account-menu', {}, [
    el('summary', {}, [
      el('span.avatar', { text: (member.display_name || member.email || '?').slice(0, 1).toUpperCase() }),
    ]),
    el('div.account-panel', {}, [
      el('div.strong', { text: member.display_name || member.email }),
      el('div.muted.small', { text: member.email }),
      el('div.muted.small', { text: `${member.account_name} · ${member.role}` }),
      el('hr'),
      el('button.link', { text: 'People', onclick: () => go('/people') }),
      session.can('manage_account') ? el('button.link', { text: 'Locations', onclick: () => go('/stores') }) : null,
      el('button.link.danger', { text: 'Sign out', onclick: async () => { await session.signOut(); await boot(); } }),
    ]),
  ]));
}

function showShell(visible) {
  document.querySelector('.shell').style.display = visible ? '' : 'none';
  document.querySelector('.topbar').style.display = visible ? '' : 'none';
  // The gate is hidden by the stylesheet, so showing it needs an explicit value.
  document.getElementById('gate').style.display = visible ? 'none' : 'block';
}

/** Decides what the browser shows: sign-in, account setup, or the app itself. */
async function boot() {
  setOutlet(document.getElementById('outlet'));
  const gate = document.getElementById('gate');

  await session.boot();

  if (!session.signedIn()) {
    showShell(false);
    clear(gate).append(authScreen(boot));
    return;
  }
  if (!session.hasAccount()) {
    showShell(false);
    clear(gate).append(accountSetupScreen(boot));
    return;
  }

  showShell(true);
  buildNav();
  buildAccountMenu();

  try {
    await refreshReference();
  } catch (err) {
    toast(`Could not reach the server: ${err.message}`, 'bad');
    return;
  }

  if (!window.location.hash) go('/');
  await render();
}

onChange(buildStorePicker);
window.addEventListener('session-changed', () => { boot(); });

document.getElementById('menu-toggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
document.getElementById('nav').addEventListener('click', () => document.body.classList.remove('nav-open'));

boot();
