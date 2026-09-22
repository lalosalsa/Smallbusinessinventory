import { api, el, qty, relative, toast, download, empty, select, today } from '../util.js';
import { activeStore, supplierOptions, categoryOptions } from '../store.js';
import { go } from '../router.js';

const filters = { search: '', supplier_id: '', category: '', only: '' };

export async function inventoryView(root) {
  const store = activeStore();
  if (!store) { root.append(empty('Add a store first, from the Stores tab.')); return; }

  const body = el('div');
  const head = el('div.page-head', {}, [
    el('div', {}, [
      el('h1', { text: `Stock — ${store.name}` }),
      el('p.muted', { text: 'Type what you count. Saving writes a dated count and updates on-hand for this store.' }),
    ]),
    el('div.row.gap', {}, [
      el('button.btn.ghost', { text: 'Export stock CSV', onclick: () => download(`/export/inventory.csv?store_id=${store.id}`) }),
      el('button.btn.ghost', { text: 'Blank count sheet', onclick: () => download(`/export/count-sheet.csv?store_id=${store.id}`) }),
      el('button.btn', { text: 'Build order sheet', onclick: () => go('/orders/new') }),
    ]),
  ]);

  const searchBox = el('input.search', {
    type: 'search', placeholder: 'Search product, SKU or category…', value: filters.search,
    oninput: debounce((e) => { filters.search = e.target.value; load(); }, 250),
  });

  const filterBar = el('div.filter-bar', {}, [
    searchBox,
    select(supplierOptions(true), { value: filters.supplier_id, onchange: (e) => { filters.supplier_id = e.target.value; load(); } }),
    select(categoryOptions(), { value: filters.category, onchange: (e) => { filters.category = e.target.value; load(); } }),
    select([
      { value: '', label: 'Everything' },
      { value: 'below_par', label: 'Below par only' },
      { value: 'below_reorder', label: 'At/below reorder point' },
    ], { value: filters.only, onchange: (e) => { filters.only = e.target.value; load(); } }),
  ]);

  root.append(head, filterBar, body);

  async function load() {
    const params = new URLSearchParams({ store_id: store.id, ...clean(filters) });
    const rows = await api(`/inventory?${params}`);
    renderCountSheet(body, store, rows, load);
  }
  await load();
}

function renderCountSheet(body, store, rows, reload) {
  body.replaceChildren();
  if (!rows.length) {
    body.append(empty('No products match. Import your product list from the Data tab to get started.'));
    return;
  }

  const inputs = new Map();
  const countDate = el('input', { type: 'date', value: today() });
  const noteInput = el('input', { type: 'text', placeholder: 'Note (optional), e.g. Monday morning count' });

  const grouped = groupBy(rows, (r) => r.category || 'Uncategorised');
  const tbody = el('tbody');

  for (const [category, items] of grouped) {
    tbody.append(el('tr.group-row', {}, [el('td', { colSpan: 8, text: category })]));
    for (const row of items) {
      const input = el('input.count-input', {
        type: 'number', step: '0.01', min: '0', inputMode: 'decimal',
        placeholder: qty(row.on_hand),
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); focusNext(input); } },
      });
      inputs.set(row.product_id, input);

      const state = row.reorder_point > 0 && row.on_hand <= row.reorder_point ? 'bad'
        : row.par_level > 0 && row.on_hand < row.par_level ? 'warn' : '';

      tbody.append(el(`tr${state ? '.' + state : ''}`, {}, [
        el('td', {}, [
          el('div.strong', { text: row.product_name }),
          el('div.muted.small', { text: [row.supplier_name, row.sku].filter(Boolean).join(' · ') || 'No supplier linked' }),
        ]),
        el('td.num', { text: qty(row.on_hand) }),
        el('td.num.muted', { text: qty(row.par_level) }),
        el('td.num.muted', { text: qty(row.reorder_point) }),
        el('td.num', { text: row.needed > 0 ? qty(row.needed) : '—' }),
        el('td.muted.small', { text: row.base_unit }),
        el('td.muted.small', { text: relative(row.last_counted) }),
        el('td', {}, [input]),
      ]));
    }
  }

  const saveBar = el('div.save-bar', {}, [
    el('div.row.gap', {}, [
      el('label.inline', {}, [el('span', { text: 'Count date' }), countDate]),
      noteInput,
    ]),
    el('div.row.gap', {}, [
      el('button.btn.ghost', { type: 'button', text: 'Fill blanks with current', onclick: () => {
        for (const row of rows) { const i = inputs.get(row.product_id); if (i && i.value === '') i.value = row.on_hand; }
      } }),
      el('button.btn', { type: 'button', text: 'Save count', onclick: save }),
    ]),
  ]);

  body.append(
    el('div.card.flush', {}, [
      el('table.data.count-table', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Product' }), el('th.num', { text: 'On hand' }), el('th.num', { text: 'Par' }),
          el('th.num', { text: 'Reorder' }), el('th.num', { text: 'Needed' }), el('th', { text: 'Unit' }),
          el('th', { text: 'Last count' }), el('th', { text: 'Counted' }),
        ])]),
        tbody,
      ]),
    ]),
    saveBar,
  );

  async function save() {
    const lines = [];
    for (const [productId, input] of inputs) {
      if (input.value !== '') lines.push({ product_id: productId, qty: Number(input.value) });
    }
    if (!lines.length) { toast('Nothing entered to save', 'warn'); return; }
    try {
      const res = await api('/counts', {
        method: 'POST',
        body: { store_id: store.id, counted_at: countDate.value, note: noteInput.value, lines },
      });
      toast(`Saved ${res.saved} counted items for ${store.name}`);
      reload();
    } catch (err) { toast(err.message, 'bad'); }
  }
}

function focusNext(current) {
  const all = [...document.querySelectorAll('.count-input')];
  const idx = all.indexOf(current);
  if (idx > -1 && all[idx + 1]) all[idx + 1].focus();
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
