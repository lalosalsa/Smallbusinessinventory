import { api, el, toast, modal, field, input, select, empty, confirmAction, relative, dateOnly } from '../util.js';
import { getState, refreshReference } from '../store.js';
import * as session from '../session.js';

const ROLE_BLURB = {
  owner: 'Everything, including people and locations',
  manager: 'Products, suppliers, pars, orders and schedules',
  staff: 'Counts stock and reads reports',
};

export async function peopleView(root) {
  const canManage = session.can('manage_account');
  const body = el('div');

  root.append(
    el('div.page-head', {}, [
      el('div', {}, [
        el('h1', { text: 'People' }),
        el('p.muted', {
          text: canManage
            ? 'Create a join code, hand it to whoever needs it, and they arrive with the role and locations you chose.'
            : 'Everyone on this account. Only an owner can change roles or hand out join codes.',
        }),
      ]),
      canManage ? el('button.btn', { text: 'Create join code', onclick: () => inviteEditor(load) }) : null,
    ]),
    body,
  );

  async function load() {
    const data = await api('/members');
    const { stores } = getState();
    body.replaceChildren();

    body.append(el('div.card.flush', {}, [
      el('table.data', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Person' }), el('th', { text: 'Role' }), el('th', { text: 'Locations' }),
          el('th.num', { text: 'Counts taken' }), el('th', { text: 'Joined' }), el('th.right', { text: '' }),
        ])]),
        el('tbody', {}, data.members.map((m) => el('tr', {}, [
          el('td', {}, [
            el('div.strong', { text: m.display_name || m.email }),
            m.display_name ? el('div.muted.small', { text: m.email }) : null,
            m.id === data.me ? el('span.pill', { text: 'you' }) : null,
          ]),
          el('td', {}, [
            el(`span.badge.role-${m.role}`, { text: m.role }),
            el('div.muted.small', { text: ROLE_BLURB[m.role] || '' }),
          ]),
          el('td.small', {
            text: m.role === 'owner' ? 'All locations'
              : m.all_locations ? 'All locations (and any added later)'
                : m.locations.map((l) => l.store_name).join(', ') || 'None yet',
          }),
          el('td.num', { text: m.counts_taken }),
          el('td.muted.small', { text: relative(m.created_at) }),
          el('td.right', {}, canManage ? [
            el('button.link', { text: 'Edit', onclick: () => memberEditor(m, stores, load) }),
            m.id === data.me ? null : el('button.link.danger', { text: 'Remove', onclick: async () => {
              if (!confirmAction(`Remove ${m.email} from this account?`)) return;
              try { await api(`/members/${m.id}`, { method: 'DELETE' }); toast('Removed'); load(); }
              catch (err) { toast(err.message, 'bad'); }
            } }),
          ] : []),
        ]))),
      ]),
    ]));

    if (canManage) {
      const active = data.invites.filter((i) => i.status === 'active');
      const spent = data.invites.filter((i) => i.status !== 'active');

      body.append(el('section.card', {}, [
        el('div.card-head', {}, [
          el('h3', { text: 'Join codes' }),
          el('button.btn.ghost.small', { text: 'Create join code', onclick: () => inviteEditor(load) }),
        ]),
        el('p.muted.small', { text: 'Anyone who signs up and types one of these joins the business straight away, with the role and locations the code carries.' }),
        active.length
          ? el('div.export-grid', {}, active.map((invite) => codeRow(invite, load)))
          : empty('No live join codes. Create one and send it to whoever needs access.'),
        spent.length
          ? el('details.spent-codes', {}, [
            el('summary', { text: `${spent.length} used or turned off` }),
            el('div.export-grid', {}, spent.map((invite) => codeRow(invite, load, true))),
          ])
          : null,
      ]));
    }
  }

  await load();
}

function codeRow(invite, reload, spent = false) {
  const limit = invite.max_uses == null
    ? 'unlimited uses'
    : `${invite.uses_left} of ${invite.max_uses} use${invite.max_uses === 1 ? '' : 's'} left`;

  const details = [
    invite.role,
    invite.all_locations ? 'all locations' : invite.locations.join(', ') || 'no locations',
    spent ? invite.reason : limit,
    invite.email ? `for ${invite.email}` : null,
    invite.expires_at && !spent ? `expires ${dateOnly(invite.expires_at)}` : null,
  ].filter(Boolean).join(' \u00b7 ');

  return el('div.export-row', {}, [
    el('div', {}, [
      el('div.row.gap', {}, [
        el('code.join-code', { text: invite.code }),
        invite.label ? el('span.muted.small', { text: invite.label }) : null,
      ]),
      el('div.muted.small', { text: details }),
    ]),
    el('div.row.gap', {}, [
      spent ? null : el('button.btn.ghost.small', { text: 'Copy', onclick: async () => {
        try { await navigator.clipboard.writeText(invite.code); toast(`Copied ${invite.code}`); }
        catch { toast(`Code is ${invite.code}`); }
      } }),
      spent ? null : el('button.link.danger', { text: 'Turn off', onclick: async () => {
        await api(`/invites/${invite.id}/revoke`, { method: 'POST' });
        toast('Join code turned off');
        reload();
      } }),
      !spent ? null : el('button.link.danger', { text: 'Delete', onclick: async () => {
        await api(`/invites/${invite.id}`, { method: 'DELETE' });
        reload();
      } }),
    ]),
  ]);
}

function inviteEditor(onSaved) {
  const { stores } = getState();
  const label = input({ placeholder: 'e.g. Weekend baristas' });
  const role = select(Object.keys(ROLE_BLURB).map((r) => ({ value: r, label: `${r} \u2014 ${ROLE_BLURB[r]}` })), { value: 'staff' });
  const email = input({ type: 'email', placeholder: 'Leave blank for anyone' });
  const maxUses = el('input.num-input', { type: 'number', min: '1', value: 1, placeholder: 'unlimited' });
  const unlimited = el('input', { type: 'checkbox', onchange: () => { maxUses.disabled = unlimited.checked; } });
  const expires = el('input.num-input', { type: 'number', min: '1', placeholder: 'never' });
  const { locationPicker, readLocations, allBox } = locationChooser(stores, { all: false, selected: [] });

  const form = el('form.modal-body', { onsubmit: async (e) => {
    e.preventDefault();
    try {
      const created = await api('/members/invite', {
        method: 'POST',
        body: {
          label: label.value.trim(),
          role: role.value,
          email: email.value.trim() || null,
          all_locations: allBox.checked,
          store_ids: readLocations(),
          max_uses: unlimited.checked ? null : Number(maxUses.value) || 1,
          expires_in_days: expires.value ? Number(expires.value) : null,
        },
      });
      close();
      onSaved();
      showCode(created);
    } catch (err) { toast(err.message, 'bad'); }
  } }, [
    el('p.muted.small', { text: 'The code works as soon as it exists. Whoever types it joins with the role and locations you set here.' }),
    field('Label (optional)', label, 'Just for you, so you remember who a code was for'),
    field('Role', role),
    el('h3.section-title', { text: 'Locations' }),
    locationPicker,
    el('h3.section-title', { text: 'Limits' }),
    el('div.grid.two', {}, [
      field('How many people can use it', el('div.row.gap', {}, [
        maxUses,
        el('label.inline.small', {}, [unlimited, el('span', { text: 'No limit' })]),
      ])),
      field('Expires in (days)', expires, 'Leave blank and it never expires'),
      field('Only this email may use it', email, 'Optional \u2014 handy for a single person'),
    ]),
    el('div.modal-foot', {}, [el('button.btn', { type: 'submit', text: 'Create code' })]),
  ]);

  const { close } = modal('New join code', form, { wide: true });
}

/** Shows the fresh code big enough to read out or write down. */
function showCode(invite) {
  const body = el('div.modal-body', {}, [
    el('p.muted', { text: 'Give this to whoever is joining. They sign up at this site, type the code, and they are in.' }),
    el('div.big-code', { text: invite.code }),
    el('div.row.gap', {}, [
      el('button.btn', { text: 'Copy code', onclick: async () => {
        try { await navigator.clipboard.writeText(invite.code); toast('Copied'); }
        catch { toast(`Code is ${invite.code}`); }
      } }),
      el('button.btn.ghost', { text: 'Done', onclick: () => close() }),
    ]),
  ]);
  const { close } = modal('Join code ready', body);
}

function memberEditor(member, stores, onSaved) {
  const role = select(Object.keys(ROLE_BLURB).map((r) => ({ value: r, label: `${r} — ${ROLE_BLURB[r]}` })), { value: member.role });
  const name = input({ value: member.display_name || '' });
  const { locationPicker, readLocations, allBox } = locationChooser(stores, {
    all: member.all_locations,
    selected: member.locations.map((l) => l.store_id),
  });

  const form = el('form.modal-body', { onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api(`/members/${member.id}`, {
        method: 'PUT',
        body: { role: role.value, display_name: name.value.trim(), all_locations: allBox.checked, store_ids: readLocations() },
      });
      toast('Saved');
      close();
      await session.refresh();
      await refreshReference();
      onSaved();
    } catch (err) { toast(err.message, 'bad'); }
  } }, [
    el('p.muted', { text: member.email }),
    field('Name', name),
    field('Role', role),
    el('h3.section-title', { text: 'Locations' }),
    locationPicker,
    member.role === 'owner' ? el('p.muted.small', { text: 'Owners always reach every location.' }) : null,
    el('div.modal-foot', {}, [el('button.btn', { type: 'submit', text: 'Save' })]),
  ]);

  const { close } = modal(member.display_name || member.email, form);
}

function locationChooser(stores, { all, selected }) {
  const allBox = el('input', { type: 'checkbox', checked: all, onchange: () => sync() });
  const boxes = stores.map((s) => {
    const box = el('input', { type: 'checkbox', value: s.id, checked: selected.includes(s.id) });
    return { store: s, box, row: el('label.inline', {}, [box, el('span', { text: s.name })]) };
  });

  function sync() { boxes.forEach((b) => { b.box.disabled = allBox.checked; }); }
  sync();

  const locationPicker = el('div.stack.gap', {}, [
    el('label.inline', {}, [allBox, el('span', { text: 'Every location, including ones added later' })]),
    el('div.location-grid', {}, boxes.map((b) => b.row)),
  ]);

  return {
    locationPicker,
    allBox,
    readLocations: () => boxes.filter((b) => b.box.checked).map((b) => b.store.id),
  };
}
