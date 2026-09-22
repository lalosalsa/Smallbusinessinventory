import { api, el, qty, money, download, empty, select, today, daysAgo } from '../util.js';
import { getState, categoryOptions } from '../store.js';

const period = {
  preset: 'month',
  from: daysAgo(29),
  to: today(),
  store_id: '',
  category: '',
  group_by: 'week',
};

const PRESETS = [
  { key: 'week', label: 'This week', days: 6, group: 'day' },
  { key: 'four_weeks', label: 'Last 4 weeks', days: 27, group: 'week' },
  { key: 'month', label: 'Last 30 days', days: 29, group: 'week' },
  { key: 'quarter', label: 'Last 90 days', days: 89, group: 'month' },
  { key: 'year', label: 'Last 12 months', days: 364, group: 'month' },
  { key: 'custom', label: 'Custom range', days: null, group: null },
];

export async function usageView(root) {
  const { stores } = getState();
  const body = el('div');

  const fromInput = el('input', { type: 'date', value: period.from, onchange: (e) => { period.from = e.target.value; period.preset = 'custom'; load(); } });
  const toInput = el('input', { type: 'date', value: period.to, onchange: (e) => { period.to = e.target.value; period.preset = 'custom'; load(); } });

  const presetTabs = el('div.tabs.sub', {}, PRESETS.map((p) => el('button.tab', {
    text: p.label,
    class: period.preset === p.key ? 'active' : '',
    onclick: () => {
      period.preset = p.key;
      if (p.days != null) {
        period.from = daysAgo(p.days);
        period.to = today();
        period.group_by = p.group;
        fromInput.value = period.from;
        toInput.value = period.to;
      }
      [...presetTabs.children].forEach((c, i) => c.classList.toggle('active', PRESETS[i].key === period.preset));
      load();
    },
  })));

  root.append(
    el('div.page-head', {}, [
      el('div', {}, [
        el('h1', { text: 'Usage' }),
        el('p.muted', { text: 'How much you actually go through: opening count + deliveries − closing count, per product, for any period.' }),
      ]),
      el('button.btn.ghost', { text: 'Export CSV', onclick: () => download(`/usage/export.csv?${query()}`) }),
    ]),
    presetTabs,
    el('div.filter-bar', {}, [
      el('label.inline', {}, [el('span.muted.small', { text: 'From' }), fromInput]),
      el('label.inline', {}, [el('span.muted.small', { text: 'To' }), toInput]),
      select([{ value: '', label: 'All locations' }, ...stores.map((s) => ({ value: s.id, label: s.name }))],
        { value: period.store_id, onchange: (e) => { period.store_id = e.target.value; load(); } }),
      select(categoryOptions(), { value: period.category, onchange: (e) => { period.category = e.target.value; load(); } }),
      select([
        { value: 'total', label: 'Totals only' },
        { value: 'day', label: 'By day' },
        { value: 'week', label: 'By week' },
        { value: 'month', label: 'By month' },
      ], { value: period.group_by, onchange: (e) => { period.group_by = e.target.value; load(); } }),
    ]),
    body,
  );

  async function load() {
    body.replaceChildren(el('div.empty', { text: 'Working it out…' }));
    const report = await api(`/usage?${query()}`);
    render(body, report);
  }
  await load();
}

function query() {
  const params = new URLSearchParams({ from: period.from, to: period.to, group_by: period.group_by });
  if (period.store_id) params.set('store_id', period.store_id);
  if (period.category) params.set('category', period.category);
  return params.toString();
}

function render(body, report) {
  body.replaceChildren();
  if (!report.rows.length) {
    body.append(empty('No usage in this period yet. Usage needs at least two counts of a product — count on Monday, count again next Monday.'));
    return;
  }

  const buckets = report.group_by === 'total' ? [] : report.buckets;
  const max = Math.max(...report.rows.map((r) => r.used), 1);

  const rows = report.rows.map((r) => el('tr', {}, [
    el('td', {}, [
      el('div.strong', { text: r.product_name }),
      el('div.muted.small', { text: [r.store_name, r.category].filter(Boolean).join(' · ') }),
    ]),
    el('td.num', {}, [
      el('div', { text: `${qty(r.used)} ${r.base_unit}` }),
      el('div.bar', {}, [el('span', { style: `width:${Math.round((r.used / max) * 100)}%` })]),
    ]),
    el('td.num', { text: qty(r.per_week) }),
    el('td.num', { text: qty(r.per_month) }),
    el('td.num.muted', { text: money(r.est_cost) }),
    ...buckets.map((b) => el('td.num.muted', { text: r.buckets[b] ? qty(r.buckets[b]) : '—' })),
  ]));

  body.append(
    el('div.metric-row.standalone', {}, [
      stat('Period', `${report.from} → ${report.to}`),
      stat('Days', report.days),
      stat('Products moving', report.totals.products),
      stat('Estimated cost of goods used', money(report.totals.est_cost)),
    ]),
    el('div.card.flush', {}, [
      el('table.data', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Product' }), el('th.num', { text: 'Used' }), el('th.num', { text: 'Per week' }),
          el('th.num', { text: 'Per month' }), el('th.num', { text: 'Est. cost' }),
          ...buckets.map((b) => el('th.num', { text: b })),
        ])]),
        el('tbody', {}, rows),
      ]),
    ]),
  );
}

function stat(label, value) {
  return el('div.metric', {}, [el('span.metric-value.sm', { text: String(value) }), el('span.metric-label', { text: label })]);
}
