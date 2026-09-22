// Hash-based router: no build step, and refreshing the page keeps you where you were.

import { el, clear, toast } from './util.js';

const routes = [];
let outlet = null;

export function route(pattern, handler) { routes.push({ pattern, handler }); }

export function setOutlet(node) { outlet = node; }

export function go(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (replace) window.history.replaceState(null, '', target);
  else window.location.hash = path;
  if (replace) render();
}

export function currentPath() {
  return (window.location.hash || '#/').slice(1) || '/';
}

export async function render() {
  if (!outlet) return;
  const full = currentPath();
  const [path, queryString = ''] = full.split('?');
  const params = new URLSearchParams(queryString);

  for (const { pattern, handler } of routes) {
    const match = matchPath(pattern, path);
    if (!match) continue;
    clear(outlet);
    outlet.scrollTop = 0;
    try {
      await handler(outlet, params, ...match);
    } catch (err) {
      clear(outlet).append(el('div.empty.bad', { text: err.message }));
      toast(err.message, 'bad');
    }
    highlightNav(path);
    return;
  }
  clear(outlet).append(el('div.empty', { text: 'Page not found' }));
}

function matchPath(pattern, path) {
  const p = pattern.split('/').filter(Boolean);
  const a = path.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const values = [];
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) values.push(decodeURIComponent(a[i]));
    else if (p[i] !== a[i]) return null;
  }
  return values;
}

function highlightNav(path) {
  for (const link of document.querySelectorAll('[data-route]')) {
    const target = link.dataset.route;
    link.classList.toggle('active', path === target || (target !== '/' && path.startsWith(target)));
  }
}

window.addEventListener('hashchange', render);
