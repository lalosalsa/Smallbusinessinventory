import { api, el, toast, download, select } from '../util.js';
import { getState, refreshReference } from '../store.js';
import * as session from '../session.js';

export async function dataView(root) {
  const { stores } = getState();
  const storeChoices = [{ value: '', label: 'Use the location column in the file' }, ...stores.map((s) => ({ value: s.id, label: s.name }))];

  root.append(
    el('div.page-head', {}, [
      el('div', {}, [
        el('h1', { text: 'Import & export' }),
        el('p.muted', { text: 'Bring your product list and counts in from a spreadsheet; take order sheets and reports back out.' }),
      ]),
    ]),
    el('div.grid.two', {}, [
      session.can('manage_catalog') ? importCard({
        title: 'Import products & supplier SKUs',
        blurb: 'One row per product per supplier. Re-importing the same file updates what is already there instead of duplicating it.',
        endpoint: '/import/products',
        storeChoices,
        storeHint: 'Location for par/on-hand columns',
        columns: [
          ['product_name', 'required — the name you count by'],
          ['category', 'e.g. Dairy, Dry goods, Packaging'],
          ['base_unit', 'what you count in: each, lb, gal…'],
          ['supplier_name', 'created automatically if new'],
          ['sku', 'the supplier’s own SKU/item code'],
          ['pack_size', 'base units per case, e.g. 24'],
          ['pack_unit', 'case, box, bag…'],
          ['unit_cost', 'price per case/pack'],
          ['store_code', 'the location code, e.g. S1 (or its full name)'],
          ['par_level', 'target stock at that location'],
          ['reorder_point', 'flag the item at or below this'],
          ['on_hand', 'current stock at that location'],
        ],
        sample: 'products-sample.csv',
      }) : null,
      session.can('count') ? importCard({
        title: 'Import a count sheet',
        blurb: 'Bring counts in from a printed or tablet sheet. Rows match on SKU first, then product name.',
        endpoint: '/import/counts',
        storeChoices,
        storeHint: 'Location these counts belong to',
        withDate: true,
        columns: [
          ['store_code', 'optional if you pick a location above'],
          ['sku', 'supplier SKU — matched first'],
          ['product_name', 'used when there is no SKU'],
          ['qty', 'required — what you counted'],
          ['counted_at', 'YYYY-MM-DD (defaults to the date you pick)'],
          ['note', 'optional'],
        ],
        sample: 'counts-sample.csv',
      }) : null,
    ]),
    el('section.card', {}, [
      el('h3', { text: 'Exports' }),
      el('p.muted.small', { text: 'Everything downloads as CSV, ready for Excel, Google Sheets, or to email straight to a supplier.' }),
      el('div.export-grid', {}, [
        exportRow('Full product & SKU list', 'Round-trips: edit it in a spreadsheet and import it back.', () => download('/export/products.csv')),
        ...stores.flatMap((s) => [
          exportRow(`Stock on hand — ${s.name}`, 'On hand, par, reorder point and what you are short.', () => download(`/export/inventory.csv?store_id=${s.id}`)),
          exportRow(`Blank count sheet — ${s.name}`, 'Print it, count it, import it back.', () => download(`/export/count-sheet.csv?store_id=${s.id}`)),
        ]),
        exportRow('Usage, last 30 days', 'Per product, with weekly and monthly averages.', () => {
          const to = new Date().toISOString().slice(0, 10);
          const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
          download(`/usage/export.csv?from=${from}&to=${to}&group_by=week`);
        }),
      ]),
      el('p.muted.small', { text: 'Order sheets export from the order itself, with the supplier’s SKUs and pack units on every line.' }),
    ]),
  );
}

function importCard({ title, blurb, endpoint, columns, storeChoices, storeHint, withDate = false, sample }) {
  const fileInput = el('input', { type: 'file', accept: '.csv,text/csv' });
  const textArea = el('textarea', { rows: 5, placeholder: '…or paste CSV rows here' });
  const storeSelect = select(storeChoices, {});
  const dateInput = withDate ? el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }) : null;
  const output = el('div.import-result');

  const card = el('section.card', {}, [
    el('h3', { text: title }),
    el('p.muted.small', { text: blurb }),
    el('div.column-help', {}, [
      el('span.muted.small', { text: 'Recognised columns (any order, common spellings accepted):' }),
      el('dl.columns', {}, columns.flatMap(([name, hint]) => [el('dt', { text: name }), el('dd', { text: hint })])),
      el('button.link', { text: 'Download a sample file', onclick: () => downloadSample(sample) }),
    ]),
    el('div.stack.gap', {}, [
      el('label.inline', {}, [el('span.muted.small', { text: storeHint }), storeSelect]),
      dateInput ? el('label.inline', {}, [el('span.muted.small', { text: 'Count date' }), dateInput]) : null,
      fileInput,
      textArea,
      el('button.btn', { text: 'Import', onclick: run }),
    ]),
    output,
  ]);

  async function run() {
    let csv = textArea.value.trim();
    if (!csv && fileInput.files[0]) csv = await fileInput.files[0].text();
    if (!csv) { toast('Choose a file or paste some rows first', 'warn'); return; }

    try {
      const body = { csv, default_store_id: storeSelect.value || null };
      if (dateInput) body.counted_at = dateInput.value;
      const res = await api(endpoint, { method: 'POST', body });
      await refreshReference();
      renderResult(output, res);
      toast('Import finished');
    } catch (err) { toast(err.message, 'bad'); }
  }

  return card;
}

function renderResult(host, res) {
  const summary = Object.entries(res)
    .filter(([k, v]) => k !== 'errors' && k !== 'unknown_columns' && typeof v === 'number')
    .map(([k, v]) => el('li', { text: `${k.replace(/_/g, ' ')}: ${v}` }));

  host.replaceChildren(
    el('h4', { text: 'Result' }),
    el('ul.tight', {}, summary),
    res.unknown_columns?.length
      ? el('p.muted.small', { text: `Columns ignored: ${res.unknown_columns.join(', ')}` })
      : null,
    res.errors?.length
      ? el('div.errors', {}, [
        el('p.warn-text.small', { text: `${res.errors.length} row(s) need attention:` }),
        el('ul.tight', {}, res.errors.slice(0, 25).map((e) => el('li.small', { text: e }))),
      ])
      : el('p.muted.small', { text: 'No problems found.' }),
  );
}

function downloadSample(name) {
  const a = document.createElement('a');
  a.href = `/samples/${name}`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function exportRow(title, blurb, onClick) {
  return el('div.export-row', {}, [
    el('div', {}, [el('div.strong', { text: title }), el('div.muted.small', { text: blurb })]),
    el('button.btn.ghost.small', { text: 'Download', onclick: onClick }),
  ]);
}
