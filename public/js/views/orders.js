import { api, el, qty, money, relative, toast, download, empty, select, table, confirmAction, dateOnly } from '../util.js';
import { getState, activeStore, setActiveStore } from '../store.js';
import { go } from '../router.js';
import * as session from '../session.js';

/* ------------------------------------------------------------- order list */

export async function ordersView(root) {
  const body = el('div');
  const statusFilter = el('div.tabs.sub', {}, ['', 'draft', 'sent', 'received'].map((s) => el('button.tab', {
    text: s === '' ? 'All' : s[0].toUpperCase() + s.slice(1),
    onclick: (e) => {
      [...statusFilter.children].forEach((c) => c.classList.remove('active'));
      e.target.classList.add('active');
      load(s);
    },
  })));
  statusFilter.firstChild.classList.add('active');

  root.append(
    el('div.page-head', {}, [
      el('div', {}, [
        el('h1', { text: 'Orders' }),
        el('p.muted', { text: 'Draft an order sheet from your pars and usage, export it as CSV for the supplier, then book the delivery back into stock.' }),
      ]),
      session.can('manage_orders') ? el('button.btn', { text: 'New order sheet', onclick: () => go('/orders/new') }) : null,
    ]),
    statusFilter,
    body,
  );

  async function load(status = '') {
    const orders = await api(`/orders${status ? `?status=${status}` : ''}`);
    body.replaceChildren();
    if (!orders.length) { body.append(empty('No orders here yet.')); return; }
    const rows = orders.map((o) => el('tr', { onclick: () => go(`/orders/${o.id}`) }, [
      el('td', { text: `#${o.id}` }),
      el('td.strong', { text: o.supplier_name }),
      el('td', { text: o.store_name }),
      el('td', {}, [el(`span.badge.${o.status}`, { text: o.status })]),
      el('td.num', { text: o.line_count }),
      el('td.num', { text: money(o.total || 0) }),
      el('td.muted', { text: relative(o.created_at) }),
    ]));
    body.append(el('div.card.flush', {}, [
      table(['Order', 'Supplier', 'Location', 'Status', 'Lines', 'Total', 'Raised'], rows, { className: 'clickable' }),
    ]));
  }
  await load();
}

/* ---------------------------------------------------------- order builder */

export async function newOrderView(root, params) {
  const { suppliers, stores } = getState();
  if (!suppliers.length) { root.append(empty('Add a supplier before building an order sheet.')); return; }

  const store = activeStore();
  const settings = {
    store_id: store?.id || stores[0]?.id,
    supplier_id: Number(params.get('supplier_id')) || suppliers[0].id,
    mode: 'both',
    days_of_cover: 7,
    lookback_days: 28,
    only_needed: true,
  };

  const results = el('div');

  const controls = el('div.card.controls', {}, [
    el('div.control-grid', {}, [
      labelled('Location', select(stores.map((s) => ({ value: s.id, label: s.name })), {
        value: settings.store_id,
        onchange: (e) => { settings.store_id = Number(e.target.value); setActiveStore(settings.store_id); build(); },
      })),
      labelled('Supplier', select(suppliers.map((s) => ({ value: s.id, label: s.name })), {
        value: settings.supplier_id,
        onchange: (e) => { settings.supplier_id = Number(e.target.value); build(); },
      })),
      labelled('Suggest from', select([
        { value: 'both', label: 'Par level or usage, whichever is higher' },
        { value: 'par', label: 'Par level only' },
        { value: 'usage', label: 'Measured usage only' },
      ], { value: settings.mode, onchange: (e) => { settings.mode = e.target.value; build(); } })),
      labelled('Days of cover', el('input.num-input', {
        type: 'number', min: '1', value: settings.days_of_cover,
        onchange: (e) => { settings.days_of_cover = Number(e.target.value) || 7; build(); },
      })),
      labelled('Usage lookback (days)', el('input.num-input', {
        type: 'number', min: '7', value: settings.lookback_days,
        onchange: (e) => { settings.lookback_days = Number(e.target.value) || 28; build(); },
      })),
      el('label.inline', {}, [
        el('input', { type: 'checkbox', checked: settings.only_needed, onchange: (e) => { settings.only_needed = e.target.checked; build(); } }),
        el('span', { text: 'Only items that need ordering' }),
      ]),
    ]),
  ]);

  root.append(
    el('div.page-head', {}, [
      el('div', {}, [
        el('h1', { text: 'Build an order sheet' }),
        el('p.muted', { text: 'Quantities are suggested in the supplier’s own pack and rounded up. Adjust anything before saving.' }),
      ]),
      el('button.btn.ghost', { text: 'All orders', onclick: () => go('/orders') }),
    ]),
    controls,
    results,
  );

  async function build() {
    results.replaceChildren(el('div.empty', { text: 'Calculating…' }));
    try {
      const data = await api('/orders/suggest', { method: 'POST', body: settings });
      renderSuggestion(results, data, settings);
    } catch (err) {
      results.replaceChildren(el('div.empty.bad', { text: err.message }));
    }
  }
  await build();
}

function renderSuggestion(host, data, settings) {
  host.replaceChildren();
  if (!data.lines.length) {
    host.append(empty(`Nothing to order from ${data.supplier.name} for ${data.store.name} right now.`));
    return;
  }

  const inputs = new Map();
  const totalCell = el('span.strong', { text: money(data.total) });
  const minNote = el('span.muted.small');

  const recalc = () => {
    let total = 0;
    for (const line of data.lines) {
      const packs = Number(inputs.get(line.product_id).value) || 0;
      total += packs * line.unit_cost;
      const cell = document.getElementById(`line-total-${line.product_id}`);
      if (cell) cell.textContent = money(packs * line.unit_cost);
    }
    totalCell.textContent = money(total);
    const min = data.supplier.min_order_value || 0;
    minNote.textContent = min && total < min
      ? `${money(min - total)} under ${data.supplier.name}’s ${money(min)} minimum`
      : min ? `Meets the ${money(min)} minimum` : '';
    minNote.className = min && total < min ? 'warn-text small' : 'muted small';
  };

  const rows = data.lines.map((line) => {
    const box = el('input.num-input', { type: 'number', min: '0', step: '1', value: line.qty_packs, oninput: recalc });
    inputs.set(line.product_id, box);
    return el(`tr${line.below_reorder ? '.bad' : ''}`, {}, [
      el('td', {}, [
        el('div.strong', { text: line.product_name }),
        el('div.muted.small', { text: `${line.sku} · ${qty(line.pack_size)} ${line.base_unit} per ${line.pack_unit}` }),
      ]),
      el('td.num', { text: qty(line.on_hand) }),
      el('td.num.muted', { text: qty(line.par_level) }),
      el('td.num.muted', { text: line.usage_per_day ? `${qty(line.usage_per_day, 2)}/day` : '—' }),
      el('td.num', { text: qty(line.need_base) }),
      el('td', {}, [box]),
      el('td.num.muted', { text: money(line.unit_cost) }),
      el('td.num', { id: `line-total-${line.product_id}`, text: money(line.line_total) }),
    ]);
  });

  const noteInput = el('input', { type: 'text', placeholder: 'Note for this order (delivery day, PO reference…)' });

  host.append(
    el('div.card.flush', {}, [
      el('div.card-head.padded', {}, [
        el('h3', { text: `${data.supplier.name} → ${data.store.name}` }),
        el('span.muted.small', { text: data.supplier.email ? `Send to ${data.supplier.email}` : 'No order email on file' }),
      ]),
      el('table.data', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Product' }), el('th.num', { text: 'On hand' }), el('th.num', { text: 'Par' }),
          el('th.num', { text: 'Usage' }), el('th.num', { text: 'Short by' }), el('th', { text: 'Order qty' }),
          el('th.num', { text: 'Price' }), el('th.num', { text: 'Line total' }),
        ])]),
        el('tbody', {}, rows),
      ]),
    ]),
    el('div.save-bar', {}, [
      el('div.stack', {}, [el('div', {}, [el('span.muted', { text: 'Order total: ' }), totalCell]), minNote]),
      el('div.row.gap', {}, [
        noteInput,
        el('button.btn.ghost', { text: 'Export CSV now', onclick: exportNow }),
        el('button.btn', { text: 'Save order sheet', onclick: save }),
      ]),
    ]),
  );
  recalc();

  function exportNow() {
    const params = new URLSearchParams({
      store_id: settings.store_id,
      supplier_id: settings.supplier_id,
      mode: settings.mode,
      days_of_cover: settings.days_of_cover,
      lookback_days: settings.lookback_days,
    });
    download(`/orders/sheet.csv?${params}`);
  }

  async function save() {
    const lines = data.lines.map((l) => ({ ...l, qty_packs: Number(inputs.get(l.product_id).value) || 0 }));
    if (!lines.some((l) => l.qty_packs > 0)) { toast('Every line is zero — nothing to order', 'warn'); return; }
    try {
      const order = await api('/orders', {
        method: 'POST',
        body: { store_id: settings.store_id, supplier_id: settings.supplier_id, note: noteInput.value, lines },
      });
      toast(`Order #${order.id} saved`);
      go(`/orders/${order.id}`);
    } catch (err) { toast(err.message, 'bad'); }
  }
}

/* ---------------------------------------------------------- order details */

export async function orderView(root, params, id) {
  const order = await api(`/orders/${id}`);
  const inputs = new Map();

  const rows = order.items.map((item) => {
    const box = el('input.num-input', {
      type: 'number', min: '0', step: '1', value: item.qty_packs,
      disabled: order.status === 'received',
      oninput: recalc,
    });
    inputs.set(item.product_id, box);
    return el('tr', {}, [
      el('td', { text: item.sku }),
      el('td', {}, [
        el('div.strong', { text: item.product_name }),
        el('div.muted.small', { text: `${qty(item.pack_size)} ${item.base_unit} per ${item.pack_unit}` }),
      ]),
      el('td', {}, [box]),
      el('td.num.muted', { text: money(item.unit_cost) }),
      el('td.num', { id: `o-line-${item.product_id}`, text: money(item.line_total) }),
    ]);
  });

  const totalCell = el('span.strong', { text: money(order.total) });
  function recalc() {
    let total = 0;
    for (const item of order.items) {
      const packs = Number(inputs.get(item.product_id).value) || 0;
      total += packs * item.unit_cost;
      document.getElementById(`o-line-${item.product_id}`).textContent = money(packs * item.unit_cost);
    }
    totalCell.textContent = money(total);
  }

  const actions = el('div.row.gap', {}, [
    el('button.btn.ghost', { text: 'Export CSV for supplier', onclick: () => download(`/orders/${order.id}/export.csv`) }),
    el('button.btn.ghost', { text: 'Copy as text', onclick: () => copyAsText(order) }),
    order.supplier_email ? el('a.btn.ghost', { href: mailto(order), text: 'Email supplier' }) : null,
    order.status !== 'received' ? el('button.btn.ghost', { text: 'Save changes', onclick: saveLines }) : null,
    order.status === 'draft' ? el('button.btn', { text: 'Mark sent', onclick: () => setStatus('sent') }) : null,
    order.status === 'sent' ? el('button.btn', { text: 'Receive delivery', onclick: receive }) : null,
    el('button.link.danger', { text: 'Delete', onclick: async () => {
      if (!confirmAction(`Delete order #${order.id}?`)) return;
      await api(`/orders/${order.id}`, { method: 'DELETE' });
      toast('Order deleted');
      go('/orders');
    } }),
  ]);

  root.append(
    el('div.page-head', {}, [
      el('div', {}, [
        el('h1', { text: `Order #${order.id} · ${order.supplier_name}` }),
        el('p.muted', { text: `${order.store_name} · raised ${dateOnly(order.created_at)}${order.sent_at ? ` · sent ${dateOnly(order.sent_at)}` : ''}${order.received_at ? ` · received ${dateOnly(order.received_at)}` : ''}` }),
      ]),
      el(`span.badge.${order.status}.big`, { text: order.status }),
    ]),
    el('div.card.flush', {}, [
      el('table.data', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'SKU' }), el('th', { text: 'Product' }), el('th', { text: 'Qty' }),
          el('th.num', { text: 'Price' }), el('th.num', { text: 'Line total' }),
        ])]),
        el('tbody', {}, rows),
      ]),
    ]),
    el('div.save-bar', {}, [
      el('div.stack', {}, [
        el('div', {}, [el('span.muted', { text: 'Order total: ' }), totalCell]),
        order.note ? el('span.muted.small', { text: order.note }) : null,
      ]),
      actions,
    ]),
    order.status === 'received' ? el('p.muted.small', { text: 'Received quantities were added to stock, so usage is measured against them.' }) : null,
  );

  async function saveLines() {
    const lines = order.items.map((i) => ({ ...i, qty_packs: Number(inputs.get(i.product_id).value) || 0 }));
    await api(`/orders/${order.id}`, { method: 'PUT', body: { lines } });
    toast('Order updated');
    go(`/orders/${order.id}`, { replace: true });
  }

  async function setStatus(status) {
    await api(`/orders/${order.id}/status`, { method: 'POST', body: { status } });
    toast(`Order marked ${status}`);
    go(`/orders/${order.id}`, { replace: true });
  }

  async function receive() {
    const lines = order.items.map((i) => ({ product_id: i.product_id, qty_packs: Number(inputs.get(i.product_id).value) || 0 }));
    await api(`/orders/${order.id}/receive`, { method: 'POST', body: { lines } });
    toast('Delivery booked into stock');
    go(`/orders/${order.id}`, { replace: true });
  }
}

function orderAsText(order) {
  const lines = order.items.map((i) => `${i.sku}\t${i.product_name}\t${qty(i.qty_packs)} ${i.pack_unit}`);
  return [
    `Order for ${order.supplier_name}`,
    `Deliver to: ${order.store_name}`,
    order.account_number ? `Account: ${order.account_number}` : null,
    '',
    ...lines,
  ].filter(Boolean).join('\n');
}

async function copyAsText(order) {
  try {
    await navigator.clipboard.writeText(orderAsText(order));
    toast('Order copied to the clipboard');
  } catch { toast('Could not copy — use the CSV export instead', 'warn'); }
}

function mailto(order) {
  const subject = `Order for ${order.store_name}${order.account_number ? ` (acct ${order.account_number})` : ''}`;
  return `mailto:${order.supplier_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(orderAsText(order))}`;
}

function labelled(label, control) {
  return el('label.stack', {}, [el('span.muted.small', { text: label }), control]);
}
