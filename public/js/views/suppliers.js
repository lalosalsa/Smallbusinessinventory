import { api, el, money, toast, modal, field, input, empty, confirmAction } from '../util.js';
import { refreshReference, getState } from '../store.js';
import { go } from '../router.js';
import * as session from '../session.js';

export async function suppliersView(root) {
  const body = el('div');
  root.append(
    el('div.page-head', {}, [
      el('div', {}, [
        el('h1', { text: 'Suppliers' }),
        el('p.muted', { text: 'Who you order from, how to reach them, and the minimum they want on an order.' }),
      ]),
      session.can('manage_catalog') ? el('button.btn', { text: 'New supplier', onclick: () => supplierEditor(null, load) }) : null,
    ]),
    body,
  );

  async function load() {
    const suppliers = await api('/suppliers');
    body.replaceChildren();
    if (!suppliers.length) { body.append(empty('No suppliers yet. Add one, or import a product CSV with a supplier column.')); return; }

    body.append(el('div.grid.three', {}, suppliers.map((s) => el('div.card', {}, [
      el('div.card-head', {}, [el('h3', { text: s.name }), el('span.pill', { text: `${s.product_count} SKUs` })]),
      el('dl.detail', {}, [
        detail('Contact', [s.contact_name, s.email, s.phone].filter(Boolean).join(' · ') || '—'),
        detail('Account #', s.account_number || '—'),
        detail('Order days', s.order_days || '—'),
        detail('Lead time', s.lead_time_days ? `${s.lead_time_days} days` : '—'),
        detail('Minimum order', s.min_order_value ? money(s.min_order_value) : '—'),
      ].flat()),
      s.notes ? el('p.muted.small', { text: s.notes }) : null,
      el('div.row.gap', {}, [
        session.can('manage_orders') ? el('button.btn.ghost.small', { text: 'Build order', onclick: () => go(`/orders/new?supplier_id=${s.id}`) }) : null,
        session.can('manage_catalog') ? el('button.link', { text: 'Edit', onclick: () => supplierEditor(s, load) }) : null,
        !session.can('manage_catalog') ? null : el('button.link.danger', { text: 'Delete', onclick: async () => {
          if (!confirmAction(`Delete ${s.name}? Its SKU links and order history go too.`)) return;
          await api(`/suppliers/${s.id}`, { method: 'DELETE' });
          await refreshReference();
          toast('Supplier deleted');
          load();
        } }),
      ]),
    ]))));
  }
  await load();
}

function detail(label, value) {
  return [el('dt', { text: label }), el('dd', { text: value })];
}

export function supplierEditor(supplier, onSaved) {
  const isNew = !supplier;
  const fields = {
    name: input({ value: supplier?.name || '', required: true }),
    contact_name: input({ value: supplier?.contact_name || '' }),
    email: input({ value: supplier?.email || '', type: 'email', placeholder: 'orders@supplier.com' }),
    phone: input({ value: supplier?.phone || '' }),
    account_number: input({ value: supplier?.account_number || '' }),
    order_days: input({ value: supplier?.order_days || '', placeholder: 'e.g. Mon, Thu' }),
    lead_time_days: input({ value: supplier?.lead_time_days ?? 0, type: 'number', min: '0' }),
    min_order_value: input({ value: supplier?.min_order_value ?? 0, type: 'number', min: '0', step: '0.01' }),
    notes: el('textarea', { rows: 3, value: supplier?.notes || '' }),
  };

  const form = el('form.modal-body', { onsubmit: submit }, [
    el('div.grid.two', {}, [
      field('Supplier name', fields.name),
      field('Contact name', fields.contact_name),
      field('Order email', fields.email, 'Shown on the order sheet so you know where to send it'),
      field('Phone', fields.phone),
      field('Account number', fields.account_number),
      field('Order days', fields.order_days),
      field('Lead time (days)', fields.lead_time_days),
      field('Minimum order value', fields.min_order_value, 'Order sheets warn when a draft falls short'),
    ]),
    field('Notes', fields.notes),
    el('div.modal-foot', {}, [el('button.btn', { type: 'submit', text: isNew ? 'Create supplier' : 'Save changes' })]),
  ]);

  const { close } = modal(isNew ? 'New supplier' : supplier.name, form, { wide: true });

  async function submit(e) {
    e.preventDefault();
    const payload = Object.fromEntries(Object.entries(fields).map(([k, node]) => [k, node.value]));
    payload.lead_time_days = Number(payload.lead_time_days) || 0;
    payload.min_order_value = Number(payload.min_order_value) || 0;
    payload.active = 1;
    try {
      if (isNew) await api('/suppliers', { method: 'POST', body: payload });
      else await api(`/suppliers/${supplier.id}`, { method: 'PUT', body: payload });
      await refreshReference();
      toast(isNew ? 'Supplier created' : 'Supplier saved');
      close();
      onSaved?.();
    } catch (err) { toast(err.message, 'bad'); }
  }
}

export async function storesView(root) {
  const body = el('div');
  root.append(
    el('div.page-head', {}, [
      el('div', {}, [
        el('h1', { text: 'Locations' }),
        el('p.muted', { text: 'Every location on this account. The short code is what CSV files use, and what the picker at the top shows.' }),
      ]),
      el('button.btn', { text: 'Add location', onclick: () => storeEditor(null, load) }),
    ]),
    body,
  );

  async function load() {
    await refreshReference();
    const { stores } = getState();
    body.replaceChildren(el('div.grid.three', {}, stores.map((s) => el('div.card', {}, [
      el('div.card-head', {}, [el('h3', { text: s.name }), el('span.pill', { text: s.code })]),
      el('p.muted.small', { text: s.address || 'No address set' }),
      el('div.row.gap', {}, [
        el('button.link', { text: 'Edit', onclick: () => storeEditor(s, load) }),
        stores.length > 1 ? el('button.link.danger', { text: 'Delete', onclick: async () => {
          if (!confirmAction(`Delete ${s.name}? All of its stock, counts and orders go too.`)) return;
          await api(`/stores/${s.id}`, { method: 'DELETE' });
          toast('Location deleted');
          load();
        } }) : null,
      ]),
    ]))));
  }
  await load();
}

function storeEditor(store, onSaved) {
  const isNew = !store;
  const name = input({ value: store?.name || '', required: true });
  const code = input({ value: store?.code || '', required: true, placeholder: 'e.g. MAIN' });
  const address = input({ value: store?.address || '' });

  const form = el('form.modal-body', { onsubmit: async (e) => {
    e.preventDefault();
    const payload = { name: name.value.trim(), code: code.value.trim().toUpperCase(), address: address.value.trim(), active: 1 };
    try {
      if (isNew) await api('/stores', { method: 'POST', body: payload });
      else await api(`/stores/${store.id}`, { method: 'PUT', body: payload });
      await refreshReference();
      toast('Location saved');
      close();
      onSaved?.();
    } catch (err) { toast(err.message, 'bad'); }
  } }, [
    field('Location name', name),
    field('Short code', code, 'Used in CSV imports and exports'),
    field('Address', address),
    el('div.modal-foot', {}, [el('button.btn', { type: 'submit', text: isNew ? 'Add location' : 'Save changes' })]),
  ]);

  const { close } = modal(isNew ? 'Add location' : store.name, form);
}
