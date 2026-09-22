// Shared helpers: API access, DOM building, formatting and toasts.

export async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export function download(path) {
  const a = document.createElement('a');
  a.href = `/api${path}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** el('div.card', { onclick }, [children]) — tiny hyperscript so views stay readable. */
export function el(spec, props = {}, children = []) {
  const [tag, ...classes] = String(spec).split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = `${node.className} ${value}`.trim();
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

export function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

export function qty(n, places = 2) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(places).replace(/\.?0+$/, '');
}

export function dateOnly(ts) { return ts ? String(ts).slice(0, 10) : ''; }

export function relative(ts) {
  if (!ts) return 'never';
  const then = new Date(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z'));
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return dateOnly(ts);
}

export function today() { return new Date().toISOString().slice(0, 10); }

export function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

export function toast(message, kind = 'ok') {
  const host = document.getElementById('toasts');
  const node = el(`div.toast.${kind}`, { text: message });
  host.appendChild(node);
  setTimeout(() => node.classList.add('show'), 10);
  setTimeout(() => { node.classList.remove('show'); setTimeout(() => node.remove(), 300); }, 4200);
}

export function confirmAction(message) { return window.confirm(message); }

/** Minimal modal used by the product/supplier editors. */
export function modal(title, bodyNode, { wide = false } = {}) {
  const backdrop = el('div.modal-backdrop');
  const close = () => backdrop.remove();
  const card = el(`div.modal${wide ? ' wide' : ''}`, {}, [
    el('header.modal-head', {}, [
      el('h2', { text: title }),
      el('button.icon-btn', { type: 'button', text: '×', title: 'Close', onclick: close }),
    ]),
    bodyNode,
  ]);
  backdrop.appendChild(card);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(backdrop);
  return { close, card };
}

export function field(label, control, hint) {
  return el('label.field', {}, [el('span.field-label', { text: label }), control, hint ? el('span.hint', { text: hint }) : null]);
}

export function input(props = {}) { return el('input', { type: 'text', ...props }); }

export function select(options, props = {}) {
  const node = el('select', props);
  for (const opt of options) {
    node.appendChild(el('option', { value: opt.value, text: opt.label, selected: String(opt.value) === String(props.value) }));
  }
  return node;
}

export function table(headers, rows, { className = '' } = {}) {
  return el(`table.data${className ? '.' + className.split(' ').join('.') : ''}`, {}, [
    el('thead', {}, [el('tr', {}, headers.map((h) => el(typeof h === 'object' ? `th.${h.className || ''}` : 'th', {
      text: typeof h === 'object' ? h.label : h,
    })))]),
    el('tbody', {}, rows),
  ]);
}

export function empty(message) { return el('div.empty', { text: message }); }
