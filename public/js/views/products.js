import { api, el, qty, money, toast, modal, field, input, select, empty, download, confirmAction } from '../util.js';
import { getState, refreshReference, supplierOptions, categoryOptions } from '../store.js';
import { go } from '../router.js';
import * as session from '../session.js';

const filters = { search: '', supplier_id: '', category: '' };

export async function productsView(root) {
  const body = el('div');

  root.append(
    el('div.page-head', {}, [
      el('div', {}, [
        el('h1', { text: 'Products & supplier SKUs' }),
        el('p.muted', { text: 'Every product carries the supplier it comes from, that supplier’s SKU, the pack it ships in and the price.' }),
      ]),
      el('div.row.gap', {}, [
        el('button.btn.ghost', { text: 'Export CSV', onclick: () => download('/export/products.csv') }),
        session.can('manage_catalog') ? el('button.btn.ghost', { text: 'Import CSV', onclick: () => go('/data') }) : null,
        session.can('manage_catalog') ? el('button.btn', { text: 'New product', onclick: () => productEditor(null, load) }) : null,
      ]),
    ]),
    el('div.filter-bar', {}, [
      el('input.search', {
        type: 'search', placeholder: 'Search name, SKU or category…', value: filters.search,
        oninput: debounce((e) => { filters.search = e.target.value; load(); }, 250),
      }),
      select(supplierOptions(true), { value: filters.supplier_id, onchange: (e) => { filters.supplier_id = e.target.value; load(); } }),
      select(categoryOptions(), { value: filters.category, onchange: (e) => { filters.category = e.target.value; load(); } }),
    ]),
    body,
  );

  async function load() {
    const params = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v)));
    const products = await api(`/products?${params}`);
    render(body, products, load);
  }
  await load();
}

function render(body, products, reload) {
  body.replaceChildren();
  if (!products.length) {
    body.append(empty('No products yet. Import your list from the Data tab, or add one by hand.'));
    return;
  }

  const { stores } = getState();
  const rows = products.map((p) => {
    const links = p.suppliers || [];
    return el('tr', {}, [
      el('td', {}, [
        el('div.strong', { text: p.name }),
        el('div.muted.small', { text: p.category || 'Uncategorised' }),
      ]),
      el('td', {}, links.length
        ? links.map((l) => el('div.small', {}, [
          el('span.strong', { text: l.supplier_name }),
          el('span.muted', { text: ` · ${l.sku} · ${qty(l.pack_size)} ${p.base_unit}/${l.pack_unit} · ${money(l.unit_cost)}` }),
        ]))
        : [el('span.muted.small', { text: 'No supplier linked' })]),
      el('td.small', {}, stores.map((s) => {
        const row = (p.stock || []).find((x) => x.store_id === s.id);
        return el('div', {}, [
          el('span.muted', { text: `${s.code}: ` }),
          el('span', { text: row ? `${qty(row.on_hand)} on hand / par ${qty(row.par_level)}` : 'not tracked' }),
        ]);
      })),
      el('td.right', {}, !session.can('manage_catalog') ? [] : [
        el('button.link', { text: 'Edit', onclick: () => productEditor(p, reload) }),
        el('button.link.danger', { text: 'Delete', onclick: async () => {
          if (!confirmAction(`Delete "${p.name}"? Counts and order history for it go too.`)) return;
          await api(`/products/${p.id}`, { method: 'DELETE' });
          toast('Product deleted');
          reload();
        } }),
      ]),
    ]);
  });

  body.append(el('div.card.flush', {}, [
    el('table.data', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Product' }), el('th', { text: 'Suppliers & SKUs' }),
        el('th', { text: 'Per store' }), el('th.right', { text: '' }),
      ])]),
      el('tbody', {}, rows),
    ]),
  ]));
}

export function productEditor(product, onSaved) {
  const { stores, suppliers } = getState();
  const isNew = !product;

  const nameInput = input({ value: product?.name || '', required: true, placeholder: 'e.g. Whole milk, 1 gal' });
  const categoryInput = input({ value: product?.category || '', placeholder: 'e.g. Dairy', list: 'category-list' });
  const unitInput = input({ value: product?.base_unit || 'each', placeholder: 'each, lb, gal, bottle…' });
  const notesInput = input({ value: product?.notes || '' });

  const linkRows = el('div.sub-rows');
  const stockRows = el('div.sub-rows');

  const addLink = (link = {}) => linkRows.append(supplierLinkRow(suppliers, link, () => {}));
  (product?.suppliers || []).forEach(addLink);
  if (!product?.suppliers?.length) addLink();

  for (const store of stores) {
    const row = (product?.stock || []).find((s) => s.store_id === store.id) || {};
    stockRows.append(el('div.sub-row', { dataset: { storeId: store.id } }, [
      el('span.sub-label', { text: store.name }),
      labelled('Par', el('input.num-input', { type: 'number', step: '0.01', min: '0', value: row.par_level ?? 0, name: 'par_level' })),
      labelled('Reorder at', el('input.num-input', { type: 'number', step: '0.01', min: '0', value: row.reorder_point ?? 0, name: 'reorder_point' })),
      labelled('On hand', el('input.num-input', { type: 'number', step: '0.01', min: '0', value: row.on_hand ?? 0, name: 'on_hand' })),
    ]));
  }

  const form = el('form.modal-body', { onsubmit: submit }, [
    el('div.grid.two', {}, [
      field('Product name', nameInput),
      field('Category', categoryInput),
      field('Counting unit', unitInput, 'The unit you count in: each, lb, gal, case…'),
      field('Notes', notesInput),
    ]),
    el('datalist', { id: 'category-list' }, categoryOptions(false).map((c) => el('option', { value: c.value }))),
    el('h3.section-title', { text: 'Suppliers & SKUs' }),
    linkRows,
    el('button.btn.ghost.small', { type: 'button', text: '+ Add supplier', onclick: () => addLink() }),
    el('h3.section-title', { text: 'Par levels per store' }),
    stockRows,
    el('div.modal-foot', {}, [
      el('button.btn', { type: 'submit', text: isNew ? 'Create product' : 'Save changes' }),
    ]),
  ]);

  const { close } = modal(isNew ? 'New product' : product.name, form, { wide: true });

  async function submit(e) {
    e.preventDefault();
    const links = [...linkRows.querySelectorAll('.sub-row')].map((r) => ({
      id: r.dataset.linkId ? Number(r.dataset.linkId) : undefined,
      supplier_id: r.querySelector('[name=supplier_id]').value,
      sku: r.querySelector('[name=sku]').value.trim(),
      pack_size: r.querySelector('[name=pack_size]').value,
      pack_unit: r.querySelector('[name=pack_unit]').value,
      unit_cost: r.querySelector('[name=unit_cost]').value,
      is_primary: r.querySelector('[name=is_primary]').checked,
    })).filter((l) => l.supplier_id && l.sku);

    if (links.length && !links.some((l) => l.is_primary)) links[0].is_primary = true;

    const stock = [...stockRows.querySelectorAll('.sub-row')].map((r) => ({
      store_id: Number(r.dataset.storeId),
      par_level: r.querySelector('[name=par_level]').value,
      reorder_point: r.querySelector('[name=reorder_point]').value,
      on_hand: r.querySelector('[name=on_hand]').value,
    }));

    const payload = {
      name: nameInput.value.trim(),
      category: categoryInput.value.trim(),
      base_unit: unitInput.value.trim() || 'each',
      notes: notesInput.value.trim(),
      active: 1,
      suppliers: links,
      stock,
    };

    try {
      if (isNew) await api('/products', { method: 'POST', body: payload });
      else await api(`/products/${product.id}`, { method: 'PUT', body: payload });
      await refreshReference();
      toast(isNew ? 'Product created' : 'Product saved');
      close();
      onSaved?.();
    } catch (err) { toast(err.message, 'bad'); }
  }
}

function supplierLinkRow(suppliers, link) {
  const row = el('div.sub-row', { dataset: link.id ? { linkId: link.id } : {} }, [
    select([{ value: '', label: 'Choose supplier…' }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))],
      { name: 'supplier_id', value: link.supplier_id || '' }),
    labelled('SKU', el('input', { name: 'sku', value: link.sku || '', placeholder: 'Supplier SKU' })),
    labelled('Pack size', el('input.num-input', { name: 'pack_size', type: 'number', step: '0.01', min: '0', value: link.pack_size ?? 1 })),
    labelled('Pack unit', el('input.num-input', { name: 'pack_unit', value: link.pack_unit || 'case' })),
    labelled('Price/pack', el('input.num-input', { name: 'unit_cost', type: 'number', step: '0.01', min: '0', value: link.unit_cost ?? 0 })),
    el('label.inline.small', {}, [
      el('input', { name: 'is_primary', type: 'checkbox', checked: link.is_primary !== 0 }),
      el('span', { text: 'Default' }),
    ]),
    el('button.icon-btn', { type: 'button', text: '×', title: 'Remove', onclick: () => row.remove() }),
  ]);
  return row;
}

function labelled(label, control) {
  return el('label.stack.small', {}, [el('span.muted', { text: label }), control]);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
