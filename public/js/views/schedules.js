import { api, el, toast, modal, field, select, input, empty, confirmAction, today } from '../util.js';
import { getState } from '../store.js';
import { go } from '../router.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function schedulesView(root) {
  const body = el('div');

  root.append(
    el('div.page-head', {}, [
      el('div', {}, [
        el('h1', { text: 'Order schedule' }),
        el('p.muted', { text: 'Set the days you order from each supplier — weekly, every two weeks, monthly, or any number of days apart. When an order day comes round, build the draft in one click.' }),
      ]),
      el('div.row.gap', {}, [
        el('button.btn.ghost', { text: 'Build all due orders', onclick: runAllDue }),
        el('button.btn', { text: 'New schedule', onclick: () => scheduleEditor(null, load) }),
      ]),
    ]),
    body,
  );

  async function load() {
    const [list, upcoming] = await Promise.all([api('/schedules'), api('/schedules/upcoming?days=30')]);
    body.replaceChildren();

    if (!list.length) {
      body.append(empty('No order days set yet. Add one so the app can tell you when it is time to order from a supplier.'));
      return;
    }

    const due = list.filter((s) => s.due_date);
    if (due.length) {
      body.append(el('section.card.due-card', {}, [
        el('div.card-head', {}, [
          el('h3', { text: `${due.length} order${due.length > 1 ? 's' : ''} due now` }),
          el('button.btn.small', { text: 'Build all due orders', onclick: runAllDue }),
        ]),
        el('div.export-grid', {}, due.map((s) => el('div.export-row', {}, [
          el('div', {}, [
            el('div.strong', { text: `${s.supplier_name} → ${s.store_name}` }),
            el('div.muted.small', {
              text: s.status === 'overdue'
                ? `Was due ${s.due_date} (${s.days_overdue} day${s.days_overdue === 1 ? '' : 's'} ago) · ${s.summary}`
                : `Due today · ${s.summary}`,
            }),
          ]),
          el('div.row.gap', {}, [
            el('button.btn.small', { text: 'Build draft', onclick: () => run(s) }),
            el('button.link', { text: 'Skip', onclick: () => skip(s) }),
          ]),
        ]))),
      ]));
    }

    body.append(el('div.card.flush', {}, [
      el('table.data', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Supplier' }), el('th', { text: 'Store' }), el('th', { text: 'Repeats' }),
          el('th', { text: 'Next order day' }), el('th', { text: 'Expected delivery' }),
          el('th', { text: 'Last raised' }), el('th.right', { text: '' }),
        ])]),
        el('tbody', {}, list.map((s) => el(`tr${s.status === 'overdue' ? '.bad' : s.status === 'due_today' ? '.warn' : ''}`, {}, [
          el('td', {}, [
            el('div.strong', { text: s.supplier_name }),
            s.name ? el('div.muted.small', { text: s.name }) : null,
            s.active ? null : el('span.badge', { text: 'paused' }),
          ]),
          el('td', { text: s.store_name }),
          el('td.small', { text: s.summary }),
          el('td', {}, [
            el('div', { text: s.due_date ? `${s.due_date}` : s.next_due }),
            el('div.muted.small', {
              text: s.due_date
                ? (s.status === 'overdue' ? `${s.days_overdue} day(s) overdue` : 'due today')
                : `in ${s.days_until} day${s.days_until === 1 ? '' : 's'}`,
            }),
          ]),
          el('td.small.muted', { text: s.expected_delivery }),
          el('td.small.muted', { text: s.last_ordered_on || '—' }),
          el('td.right', {}, [
            s.due_date
              ? el('button.link', { text: 'Build draft', onclick: () => run(s) })
              : el('button.link', { text: 'Order early', onclick: () => run(s, true) }),
            el('button.link', { text: 'Edit', onclick: () => scheduleEditor(s, load) }),
            el('button.link.danger', { text: 'Delete', onclick: async () => {
              if (!confirmAction(`Delete the ${s.supplier_name} order day?`)) return;
              await api(`/schedules/${s.id}`, { method: 'DELETE' });
              toast('Schedule deleted');
              load();
            } }),
          ]),
        ]))),
      ]),
    ]));

    body.append(calendar(upcoming));
  }

  async function run(schedule, force = false) {
    try {
      const res = await api(`/schedules/${schedule.id}/run`, { method: 'POST', body: { force } });
      if (res.order) { toast(`Draft order #${res.order.id} raised for ${schedule.supplier_name}`); go(`/orders/${res.order.id}`); }
      else { toast(`${schedule.supplier_name}: nothing is below par, so no order was raised`, 'warn'); load(); }
    } catch (err) { toast(err.message, 'bad'); }
  }

  async function skip(schedule) {
    await api(`/schedules/${schedule.id}/run`, { method: 'POST', body: { skip: true } });
    toast(`Skipped this ${schedule.supplier_name} order day`);
    load();
  }

  async function runAllDue() {
    const { runs } = await api('/schedules/run-due', { method: 'POST' });
    if (!runs.length) { toast('No orders are due right now'); return; }
    const made = runs.filter((r) => r.order).length;
    toast(`${made} draft order${made === 1 ? '' : 's'} raised from ${runs.length} due schedule${runs.length === 1 ? '' : 's'}`);
    load();
  }

  await load();
}

/** Next 30 days, grouped by date, so you can see the week ahead at a glance. */
function calendar(upcoming) {
  if (!upcoming.length) return el('div');
  const byDate = new Map();
  for (const row of upcoming) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  return el('section.card', {}, [
    el('h3', { text: 'Next 30 days' }),
    el('div.calendar', {}, [...byDate.entries()].map(([date, rows]) => el('div.cal-day', {}, [
      el('div.cal-date', {}, [
        el('span.strong', { text: new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) }),
        date === today() ? el('span.pill', { text: 'today' }) : null,
      ]),
      el('div.cal-items', {}, rows.map((r) => el(`span.cal-chip${r.is_due ? '.due' : ''}`, {
        text: `${r.schedule.supplier_name} → ${r.schedule.store_code}`,
        title: `${r.schedule.summary} · delivery about ${r.schedule.expected_delivery}`,
      }))),
    ]))),
  ]);
}

export function scheduleEditor(schedule, onSaved) {
  const { stores, suppliers } = getState();
  const isNew = !schedule;
  if (!suppliers.length) { toast('Add a supplier first', 'warn'); return; }

  const supplierSelect = select(suppliers.map((s) => ({ value: s.id, label: s.name })),
    { name: 'supplier_id', value: schedule?.supplier_id || suppliers[0].id });
  const storeSelect = select(stores.map((s) => ({ value: s.id, label: s.name })),
    { name: 'store_id', value: schedule?.store_id || stores[0]?.id });
  const nameInput = input({ name: 'name', value: schedule?.name || '', placeholder: 'e.g. Weekly dairy order' });

  const frequencySelect = select([
    { value: 'weekly', label: 'Every week' },
    { value: 'biweekly', label: 'Every 2 weeks' },
    { value: 'monthly', label: 'Every month' },
    { value: 'days', label: 'Custom — every N days' },
  ], { name: 'frequency', value: schedule?.frequency || 'weekly', onchange: () => syncFrequency() });

  const dayOfWeek = select(WEEKDAYS.map((d, i) => ({ value: i, label: d })),
    { name: 'day_of_week', value: schedule?.day_of_week ?? 1 });
  const dayOfMonth = el('input.num-input', { name: 'day_of_month', type: 'number', min: '1', max: '31', value: schedule?.day_of_month ?? 1 });
  const intervalDays = el('input.num-input', { name: 'interval_days', type: 'number', min: '1', value: schedule?.interval_days ?? 10 });
  const anchorDate = el('input', { name: 'anchor_date', type: 'date', value: (schedule?.anchor_date || today()).slice(0, 10) });

  const leadTime = el('input.num-input', { name: 'lead_time_days', type: 'number', min: '0', value: schedule?.lead_time_days ?? '', placeholder: 'supplier default' });
  const modeSelect = select([
    { value: 'both', label: 'Par level or usage, whichever is higher' },
    { value: 'par', label: 'Par level only' },
    { value: 'usage', label: 'Measured usage only' },
  ], { name: 'mode', value: schedule?.mode || 'both' });
  const daysOfCover = el('input.num-input', { name: 'days_of_cover', type: 'number', min: '1', value: schedule?.days_of_cover ?? 7 });
  const lookback = el('input.num-input', { name: 'lookback_days', type: 'number', min: '7', value: schedule?.lookback_days ?? 28 });
  const autoDraft = el('input', { name: 'auto_draft', type: 'checkbox', checked: schedule ? !!schedule.auto_draft : true });
  const activeBox = el('input', { name: 'active', type: 'checkbox', checked: schedule ? !!schedule.active : true });
  const noteInput = input({ name: 'note', value: schedule?.note || '', placeholder: 'Anything to remember when placing it' });

  const weekRow = field('Order day', dayOfWeek);
  const monthRow = field('Day of the month', dayOfMonth, 'Short months use their last day');
  const intervalRow = field('Days between orders', intervalDays);
  const preview = el('p.muted.small');

  function syncFrequency() {
    const f = frequencySelect.value;
    weekRow.style.display = f === 'weekly' || f === 'biweekly' ? '' : 'none';
    monthRow.style.display = f === 'monthly' ? '' : 'none';
    intervalRow.style.display = f === 'days' ? '' : 'none';
    preview.textContent = f === 'biweekly'
      ? 'The fortnightly rhythm counts forward from the start date below.'
      : f === 'days' ? 'Counts forward from the start date below.' : '';
  }

  const form = el('form.modal-body', { onsubmit: submit }, [
    el('div.grid.two', {}, [
      field('Supplier', supplierSelect),
      field('Store', storeSelect),
      field('Label (optional)', nameInput),
      field('Repeats', frequencySelect),
      weekRow,
      monthRow,
      intervalRow,
      field('Starting from', anchorDate, 'The first order day this schedule applies to'),
      field('Lead time (days)', leadTime, 'Used to show the expected delivery date'),
    ]),
    preview,
    el('h3.section-title', { text: 'How the draft is built' }),
    el('div.grid.two', {}, [
      field('Suggest quantities from', modeSelect),
      field('Days of cover', daysOfCover),
      field('Usage lookback (days)', lookback),
    ]),
    el('label.inline', {}, [autoDraft, el('span', { text: 'Include in “Build all due orders”' })]),
    el('label.inline', {}, [activeBox, el('span', { text: 'Schedule is active' })]),
    field('Note', noteInput),
    el('div.modal-foot', {}, [el('button.btn', { type: 'submit', text: isNew ? 'Create schedule' : 'Save schedule' })]),
  ]);

  const { close } = modal(isNew ? 'New order day' : `${schedule.supplier_name} order day`, form, { wide: true });
  syncFrequency();

  async function submit(e) {
    e.preventDefault();
    const payload = {
      supplier_id: supplierSelect.value,
      store_id: storeSelect.value,
      name: nameInput.value.trim(),
      frequency: frequencySelect.value,
      day_of_week: ['weekly', 'biweekly'].includes(frequencySelect.value) ? Number(dayOfWeek.value) : null,
      day_of_month: frequencySelect.value === 'monthly' ? Number(dayOfMonth.value) : null,
      interval_days: frequencySelect.value === 'days' ? Number(intervalDays.value) : null,
      anchor_date: anchorDate.value,
      lead_time_days: leadTime.value === '' ? null : Number(leadTime.value),
      mode: modeSelect.value,
      days_of_cover: Number(daysOfCover.value) || 7,
      lookback_days: Number(lookback.value) || 28,
      auto_draft: autoDraft.checked,
      active: activeBox.checked,
      note: noteInput.value.trim(),
    };
    try {
      if (isNew) await api('/schedules', { method: 'POST', body: payload });
      else await api(`/schedules/${schedule.id}`, { method: 'PUT', body: payload });
      toast(isNew ? 'Order day added' : 'Schedule saved');
      close();
      onSaved?.();
    } catch (err) { toast(err.message, 'bad'); }
  }
}
