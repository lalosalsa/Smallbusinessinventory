import { api, el, money, qty, relative, empty, table, download } from '../util.js';
import { setActiveStore } from '../store.js';
import { go } from '../router.js';
import * as session from '../session.js';

export async function dashboardView(root) {
  const data = await api('/dashboard');

  const storeCards = data.stores.map((s) => el('div.card.store-card', {}, [
    el('div.card-head', {}, [
      el('h3', { text: s.name }),
      el('span.pill', { text: s.code }),
    ]),
    el('div.metric-row', {}, [
      metric('Items tracked', s.tracked || 0),
      metric('Below par', s.below_par || 0, (s.below_par || 0) > 0 ? 'warn' : ''),
      metric('At reorder point', s.below_reorder || 0, (s.below_reorder || 0) > 0 ? 'bad' : ''),
      metric('Stock value', money(s.stock_value)),
    ]),
    el('p.muted', { text: `Last count ${relative(s.last_count)} · stock updated ${relative(s.last_update)}` }),
    el('div.row.gap', {}, [
      el('button.btn', { text: 'Count stock', onclick: () => { setActiveStore(s.id); go('/inventory'); } }),
      session.can('manage_orders') ? el('button.btn.ghost', { text: 'Build order', onclick: () => { setActiveStore(s.id); go('/orders/new'); } }) : null,
      el('button.btn.ghost', { text: 'Export count sheet', onclick: () => download(`/export/count-sheet.csv?store_id=${s.id}`) }),
    ]),
  ]));

  const orderRows = data.open_orders.map((o) => el('tr', { onclick: () => go(`/orders/${o.id}`) }, [
    el('td', { text: `#${o.id}` }),
    el('td', { text: o.supplier_name }),
    el('td', { text: o.store_name }),
    el('td', {}, [el(`span.badge.${o.status}`, { text: o.status })]),
    el('td.num', { text: money(o.total || 0) }),
    el('td.muted', { text: relative(o.created_at) }),
  ]));

  const usageRows = data.top_usage.map((u) => el('tr', {}, [
    el('td', { text: u.product_name }),
    el('td.muted', { text: u.store_name }),
    el('td.num', { text: `${qty(u.used)} ${u.base_unit}` }),
    el('td.num', { text: qty(u.per_week) }),
    el('td.num', { text: money(u.est_cost) }),
  ]));

  const dueRows = (data.schedule_due || []).map((d) => el('div.export-row', {}, [
    el('div', {}, [
      el('div.strong', { text: `${d.schedule.supplier_name} \u2192 ${d.schedule.store_name}` }),
      el('div.muted.small', {
        text: d.status === 'overdue'
          ? `Order day was ${d.date} \u00b7 ${d.schedule.summary}`
          : `Order day is today \u00b7 ${d.schedule.summary}`,
      }),
    ]),
    el('button.btn.small', { text: 'Build draft', onclick: () => go('/schedule') }),
  ]));

  root.append(
    el('div.page-head', {}, [
      el('div', {}, [
        el('h1', { text: 'Overview' }),
        el('p.muted', { text: `${data.counts.products} products · ${data.counts.suppliers} suppliers · ${data.counts.skus} supplier SKUs` }),
      ]),
      el('div.row.gap', {}, [
        session.can('manage_orders') ? el('button.btn', { text: 'New order', onclick: () => go('/orders/new') }) : null,
        session.can('manage_catalog') ? el('button.btn.ghost', { text: 'Import CSV', onclick: () => go('/data') }) : null,
      ]),
    ]),
    dueRows.length
      ? el('section.card.due-card', {}, [
        el('div.card-head', {}, [
          el('h3', { text: `${dueRows.length} supplier order${dueRows.length > 1 ? 's' : ''} due` }),
          el('button.link', { text: 'Order schedule', onclick: () => go('/schedule') }),
        ]),
        el('div.export-grid', {}, dueRows),
      ])
      : null,
    el('div.grid.two', {}, storeCards),
    el('div.grid.two', {}, [
      el('section.card', {}, [
        el('div.card-head', {}, [el('h3', { text: 'Open orders' }), el('button.link', { text: 'All orders', onclick: () => go('/orders') })]),
        orderRows.length
          ? table(['Order', 'Supplier', 'Location', 'Status', 'Total', 'Raised'], orderRows, { className: 'clickable' })
          : empty('Nothing open. Build an order from the Orders tab.'),
      ]),
      el('section.card', {}, [
        el('div.card-head', {}, [el('h3', { text: 'Order days ahead' }), el('button.link', { text: 'Schedule', onclick: () => go('/schedule') })]),
        (data.schedule_upcoming || []).length
          ? el('ul.tight', {}, data.schedule_upcoming.map((u) => el('li', {
            text: `${u.date} \u2014 ${u.schedule.supplier_name} \u2192 ${u.schedule.store_code} (${u.schedule.summary.toLowerCase()})`,
          })))
          : empty('No standing order days set. Add them under Order schedule.'),
      ]),
      el('section.card', {}, [
        el('div.card-head', {}, [
          el('h3', { text: 'Most used, last 28 days' }),
          el('button.link', { text: 'Usage report', onclick: () => go('/usage') }),
        ]),
        usageRows.length
          ? table(['Product', 'Location', 'Used', 'Per week', 'Est. cost'], usageRows)
          : empty('Usage appears once you have two counts for a product.'),
      ]),
    ]),
  );
}

function metric(label, value, tone = '') {
  return el(`div.metric${tone ? '.' + tone : ''}`, {}, [
    el('span.metric-value', { text: String(value) }),
    el('span.metric-label', { text: label }),
  ]);
}
