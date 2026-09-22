import { el, toast } from './util.js';
import { route, render, setOutlet, go } from './router.js';
import { refreshReference, getState, setActiveStore, onChange } from './store.js';
import { dashboardView } from './views/dashboard.js';
import { inventoryView } from './views/inventory.js';
import { productsView } from './views/products.js';
import { suppliersView, storesView } from './views/suppliers.js';
import { ordersView, newOrderView, orderView } from './views/orders.js';
import { schedulesView } from './views/schedules.js';
import { usageView } from './views/usage.js';
import { dataView } from './views/data.js';

const NAV = [
  { path: '/', label: 'Overview' },
  { path: '/inventory', label: 'Stock & counts' },
  { path: '/orders', label: 'Orders' },
  { path: '/schedule', label: 'Order schedule' },
  { path: '/usage', label: 'Usage' },
  { path: '/products', label: 'Products' },
  { path: '/suppliers', label: 'Suppliers' },
  { path: '/data', label: 'Import / export' },
  { path: '/stores', label: 'Stores' },
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

function buildNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...NAV.map((item) => el('a.nav-link', {
    href: `#${item.path}`,
    text: item.label,
    dataset: { route: item.path },
  })));
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

async function boot() {
  setOutlet(document.getElementById('outlet'));
  buildNav();
  onChange(buildStorePicker);

  try {
    await refreshReference();
  } catch (err) {
    toast(`Could not reach the server: ${err.message}`, 'bad');
    return;
  }

  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.body.classList.toggle('nav-open');
  });
  document.getElementById('nav').addEventListener('click', () => document.body.classList.remove('nav-open'));

  if (!window.location.hash) go('/');
  await render();
}

boot();
