import { api, el, toast, modal, field, input, select, empty, confirmAction, relative } from '../util.js';
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
            ? 'Invite the people who work for you and choose which locations each of them can see.'
            : 'Everyone on this account. Only an owner can change roles or invite people.',
        }),
      ]),
      canManage ? el('button.btn', { text: 'Invite someone', onclick: () => inviteEditor(load) }) : null,
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
      body.append(el('section.card', {}, [
        el('h3', { text: 'Pending invitations' }),
        data.invites.length
          ? el('div.export-grid', {}, data.invites.map((i) => el('div.export-row', {}, [
            el('div', {}, [
              el('div.strong', { text: i.email }),
              el('div.muted.small', { text: `${i.role} · ${i.all_locations ? 'all locations' : `${i.store_ids.length} location(s)`} · invited ${relative(i.created_at)}` }),
            ]),
            el('button.link.danger', { text: 'Cancel', onclick: async () => {
              await api(`/invites/${i.id}`, { method: 'DELETE' });
              toast('Invitation cancelled');
              load();
            } }),
          ])))
          : empty('Nobody is waiting to join. Invited people appear here until they sign in for the first time.'),
        el('p.muted.small', {
          text: session.mode() === 'supabase'
            ? 'An invited person signs up through Supabase with the address you invited, and joins this account automatically.'
            : 'An invited person creates a sign-in with the address you invited, and joins this account automatically.',
        }),
      ]));
    }
  }

  await load();
}

function inviteEditor(onSaved) {
  const { stores } = getState();
  const email = input({ type: 'email', required: true, placeholder: 'them@yourbusiness.com' });
  const role = select(Object.keys(ROLE_BLURB).map((r) => ({ value: r, label: `${r} — ${ROLE_BLURB[r]}` })), { value: 'staff' });
  const { locationPicker, readLocations, allBox } = locationChooser(stores, { all: false, selected: [] });

  const form = el('form.modal-body', { onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('/members/invite', {
        method: 'POST',
        body: { email: email.value.trim(), role: role.value, all_locations: allBox.checked, store_ids: readLocations() },
      });
      toast('Invitation ready — they join when they first sign in');
      close();
      onSaved();
    } catch (err) { toast(err.message, 'bad'); }
  } }, [
    field('Email address', email, 'They join this account the first time they sign in with it'),
    field('Role', role),
    el('h3.section-title', { text: 'Locations' }),
    locationPicker,
    el('div.modal-foot', {}, [el('button.btn', { type: 'submit', text: 'Send invitation' })]),
  ]);

  const { close } = modal('Invite someone', form);
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
